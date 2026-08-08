-- Create database
CREATE DATABASE amount_management_db;

-- Connect to database
\c amount_management_db;

-- Create members table
CREATE TABLE members (
    id SERIAL PRIMARY KEY,
    member_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(20) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    balance DECIMAL(12, 2) DEFAULT 0.00,
    status VARCHAR(20) DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create monthly payments table
CREATE TABLE monthly_payments (
    id SERIAL PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    month VARCHAR(20) NOT NULL,
    payment_date DATE NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING',
    payment_method VARCHAR(50),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create withdrawals table
CREATE TABLE withdrawals (
    id SERIAL PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    month VARCHAR(20) NOT NULL,
    withdrawal_date DATE NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    reason TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create transactions table
CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    transaction_date DATE NOT NULL,
    month VARCHAR(20) NOT NULL,
    transaction_type VARCHAR(20) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    description TEXT,
    balance_after DECIMAL(12, 2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create admin users table
CREATE TABLE admin_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    status VARCHAR(20) DEFAULT 'ACTIVE',
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create OTP table for password reset
CREATE TABLE member_otp (
    id SERIAL PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    otp_code VARCHAR(10) NOT NULL,
    purpose VARCHAR(50) DEFAULT 'PASSWORD_RESET',
    status VARCHAR(20) DEFAULT 'PENDING',
    expires_at TIMESTAMP NOT NULL,
    attempts INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create payment proofs table
CREATE TABLE payment_proofs (
    id SERIAL PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    transaction_reference VARCHAR(100),
    payment_date DATE NOT NULL,
    proof_file_path VARCHAR(255),
    proof_file_name VARCHAR(255),
    status VARCHAR(20) DEFAULT 'PENDING',
    rejection_reason TEXT,
    verified_by INTEGER REFERENCES admin_users(id),
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create import history table
CREATE TABLE import_history (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    imported_records INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'SUCCESS',
    import_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);

-- Create indexes for performance
CREATE INDEX idx_members_member_id ON members(member_id);
CREATE INDEX idx_members_email ON members(email);
CREATE INDEX idx_members_phone ON members(phone);
CREATE INDEX idx_payments_member_month ON monthly_payments(member_id, month);
CREATE INDEX idx_withdrawals_member_month ON withdrawals(member_id, month);
CREATE INDEX idx_transactions_member_date ON transactions(member_id, transaction_date);
CREATE INDEX idx_transactions_month ON transactions(month);
CREATE INDEX idx_member_otp_member_id ON member_otp(member_id);
CREATE INDEX idx_member_otp_status ON member_otp(status);
CREATE INDEX idx_payment_proofs_member_id ON payment_proofs(member_id);
CREATE INDEX idx_payment_proofs_status ON payment_proofs(status);

-- Insert initial admin user (password: Admin@123456 - hash should be updated in production)
INSERT INTO admin_users (username, password_hash, email, status) 
VALUES ('admin', '$2b$10$YourHashedPasswordHere', 'admin@amount-management.com', 'ACTIVE');
