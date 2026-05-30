CREATE TABLE IF NOT EXISTS planner_profiles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_planner_profiles_owner
  ON planner_profiles(owner_id);

CREATE TABLE IF NOT EXISTS observing_programs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  program_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES planner_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_observing_programs_profile
  ON observing_programs(profile_id);

CREATE TABLE IF NOT EXISTS saved_exposure_plans (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  target_name TEXT NOT NULL,
  target_type TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  captured_hours REAL NOT NULL DEFAULT 0,
  goal_hours REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (program_id) REFERENCES observing_programs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_saved_exposure_plans_program
  ON saved_exposure_plans(program_id);
