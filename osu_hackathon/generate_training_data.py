import pandas as pd
import numpy as np
import random
import ieee738  # The library provided in the repo
from ieee738.ieee738 import ConductorParams
from ieee738.ieee738 import Conductor
from tqdm import tqdm # For a nice progress bar

# Define the number of random scenarios you want to simulate
NUM_SAMPLES_TO_GENERATE = 50000


def load_master_data():
    """
    Loads and merges all required data from the CSVs into a single,
    denormalized DataFrame.
    """
    print("Loading and merging data files...")
    # Load all the base CSVs
    lines_df = pd.read_csv('hawaii40_osu/csv/lines.csv')
    busses_df = pd.read_csv('hawaii40_osu/csv/buses.csv')
    flows_df = pd.read_csv('hawaii40_osu/line_flows_nominal.csv')
    conductor_lib_df = pd.read_csv('ieee738/conductor_library.csv')

    # --- Step 1: Get Voltage (v_nom) ---
    # We only need the voltage from the busses table
    busses_voltages = busses_df[['name', 'v_nom']]
    # Merge it onto our lines, matching line.bus0 with bus.name
    master_df = pd.merge(lines_df, busses_voltages, left_on='bus0', right_on='name', 
                         suffixes=('', '_bus'))
    # We can drop the redundant bus name column
    master_df = master_df.drop(columns=['name_bus'])
    
    # --- Step 2: Get Nominal Load (p0_nominal) ---
    # The README shows line_flows_nominal.csv has 'name' and 'p0_nominal'
    master_df = pd.merge(master_df, flows_df, on='name')

    # --- Step 3: Get Conductor Properties ---
    # Merge based on the conductor type
    master_df = pd.merge(master_df, conductor_lib_df, 
                         left_on='conductor', right_on='ConductorName')
    
    print("Data merging complete.")
    return master_df

def calculate_line_status(line_row, ambient_temp, wind_speed, load_multiplier):
    """
    Calculates the physics for a single line under given conditions.
    This version has NO try/except block, so it will crash on errors.
    """

    # --- 1. Prepare Conductor Parameters ---
    # Convert from Ohms/Mi to Ohms/ft
    res_lo_ft = line_row['RES_25C'] / 5280
    res_hi_ft = line_row['RES_50C'] / 5280
    
    # --- !!! THIS IS THE MOST LIKELY BUG !!! ---
    # Your conductor_library.csv has a column named 'CDRAD_in' (lowercase 'in').
    # Make SURE this line matches that column name EXACTLY.
    diameter_ft = (line_row['CDRAD_in'] * 2) / 12 

    acsr_params = {
        'TLo': 25, 'THi': 50,
        'RLo': res_lo_ft, 'RHi': res_hi_ft,
        'Diameter': diameter_ft,
        'Tc': line_row['MOT']  # Max Operating Temperature (Conductor Temp)
    }

    # --- 2. Prepare Ambient Parameters ---
    # Use defaults from README, but override with our random inputs
    ambient_params = {
        'Ta': ambient_temp,
        'WindVelocity': wind_speed,  # README says this is in ft/sec
        'WindAngleDeg': 90,
        'SunTime': 12, 'Date': '12 Jun', 'Emissivity': 0.8,
        'Absorptivity': 0.8, 'Direction': 'EastWest', 'Atmosphere': 'Clear',
        'Elevation': 1000, 'Latitude': 27,
    }

    # --- 3. Run the IEEE-738 Calculation ---
    # This requires 'import ieee738' at the top of your script
    cp = ConductorParams(**ambient_params, **acsr_params)
    con = Conductor(cp)
    rating_amps = con.steady_state_thermal_rating()

    # --- 4. Convert Amps to MVA (Rating) ---
    # Formula from README: S_MVA = sqrt(3) * I_Amps * V * 10^-6
    V = line_row['v_nom'] * 1000  # e.g., 138kV -> 138000V
    rating_mva = (3**0.5) * rating_amps * V * 1e-6

    # --- 5. Calculate Current Load ---
    current_load_mva = line_row['p0_nominal'] * load_multiplier

    # --- 6. Calculate Loading % and Stress ---
    # Add a safety check to prevent division by zero
    if rating_mva == 0: 
        return (0, 0) 
    
    loading_percent = (current_load_mva / rating_mva) * 100

    is_overloaded = 1 if loading_percent > 100 else 0
    stress_score = max(0, loading_percent - 100) # Only count stress above 100%

    return (is_overloaded, stress_score)


def main():
    master_df = load_master_data()
    training_samples = [] # This will hold all our results
    
    print(f"Generating {NUM_SAMPLES_TO_GENERATE} training samples...")
    
    # Use tqdm for a progress bar
    for _ in tqdm(range(NUM_SAMPLES_TO_GENERATE)):
        
        # --- 1. Generate random inputs ---
        rand_temp = random.uniform(0, 60)  # Ambient temp between 0-60 C
        rand_wind = random.uniform(0.1, 15) # Wind between 0.1-15 ft/sec
        rand_load_mult = random.choice([1.0,1.5,2.0,2.5,3.0]) # Min, Nom, Max

        # --- 2. Simulate the entire grid for these inputs ---
        total_overloaded = 0
        total_stress = 0
        
        # Loop through every line in our master table
        for _, line_row in master_df.iterrows():
            is_overloaded, stress_score = calculate_line_status(
                line_row, rand_temp, rand_wind, rand_load_mult
            )
            total_overloaded += is_overloaded
            total_stress += stress_score
            
        # --- 3. Store the results ---
        training_samples.append([
            rand_temp, rand_wind, rand_load_mult,
            total_overloaded, total_stress
        ])

    # --- 4. Save to CSV ---
    print("Saving data to CSV...")
    columns = [
        'temp', 'wind', 'load_mult', 
        'num_overloaded', 'total_stress_score'
    ]
    final_df = pd.DataFrame(training_samples, columns=columns)
    final_df.to_csv('training_data.csv', index=False)
    print("Data generation complete! 'training_data.csv' created.")

if __name__ == "__main__":
    main()
