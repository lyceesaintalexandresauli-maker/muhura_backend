-- Create database
-- Run: createdb school_db

-- Users table for application profiles linked to Supabase Auth
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  auth_user_id UUID UNIQUE,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  full_name VARCHAR(120),
  phone VARCHAR(30),
  bio TEXT,
  profile_image VARCHAR(500),
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'teacher', 'secretary', 'dos')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Content table for pages like about, academic, etc.
CREATE TABLE content (
  id SERIAL PRIMARY KEY,
  page TEXT NOT NULL,
  section TEXT,
  title VARCHAR(255),
  content TEXT,
  image_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category VARCHAR(50),
  image_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE announcements (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT,
  image_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE staff (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  position VARCHAR(100),
  department VARCHAR(100),
  bio TEXT,
  image_path VARCHAR(500),
  email VARCHAR(100),
  phone VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE departments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(10) UNIQUE NOT NULL,
  description TEXT,
  image_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE contact_info (
  id SERIAL PRIMARY KEY,
  type VARCHAR(50),
  value VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE students (
  id SERIAL PRIMARY KEY,
  student_code VARCHAR(50) UNIQUE NOT NULL,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  gender VARCHAR(20),
  date_of_birth DATE,
  class_level VARCHAR(30),
  department VARCHAR(50),
  parent_name VARCHAR(120),
  parent_phone VARCHAR(30),
  email VARCHAR(120),
  address TEXT,
  image_path VARCHAR(500),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE contact_messages (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(150) NOT NULL,
  subject VARCHAR(255),
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'archived')),
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE files (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255),
  path VARCHAR(500) NOT NULL,
  type VARCHAR(50),
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE navigation_items (
  id SERIAL PRIMARY KEY,
  parent_id INTEGER REFERENCES navigation_items(id) ON DELETE CASCADE,
  label VARCHAR(120) NOT NULL,
  href VARCHAR(255),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE site_settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) UNIQUE NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE timetables (
  id SERIAL PRIMARY KEY,
  class_name VARCHAR(100) NOT NULL,
  department VARCHAR(50) NOT NULL,
  trade_level VARCHAR(50) NOT NULL,
  academic_year VARCHAR(20) NOT NULL,
  term VARCHAR(20) NOT NULL,
  schedule_data JSONB NOT NULL,
  created_by INTEGER REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE teacher_timetables (
  id SERIAL PRIMARY KEY,
  teacher_code VARCHAR(20) NOT NULL,
  teacher_name VARCHAR(100) NOT NULL,
  timetable_id INTEGER REFERENCES timetables(id) ON DELETE CASCADE,
  subjects JSONB,
  classes JSONB,
  schedule_data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE timetable_distributions (
  id SERIAL PRIMARY KEY,
  timetable_id INTEGER REFERENCES timetables(id) ON DELETE CASCADE,
  recipient_type VARCHAR(20) NOT NULL CHECK (recipient_type IN ('class', 'teacher', 'department')),
  recipient_id VARCHAR(100) NOT NULL,
  distributed_by INTEGER REFERENCES users(id),
  distributed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'failed'))
);

CREATE TABLE school_workers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  location VARCHAR(100) NOT NULL,
  phone_number VARCHAR(20) NOT NULL,
  national_id VARCHAR(20) UNIQUE NOT NULL,
  job_type VARCHAR(50) NOT NULL,
  age INTEGER NOT NULL CHECK (age >= 18 AND age <= 70),
  salary DECIMAL(10, 2) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_school_workers_job_type ON school_workers(job_type);
CREATE INDEX idx_school_workers_location ON school_workers(location);
CREATE INDEX idx_school_workers_is_active ON school_workers(is_active);
