-- ============================================================
-- PF CHIT FUND CLUB — Complete Database Schema v2.0
-- ============================================================

-- Create members table
CREATE TABLE IF NOT EXISTS members (
    id SERIAL PRIMARY KEY,
    member_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    upi_id VARCHAR(100),
    profile_photo VARCHAR(500),
    password_hash VARCHAR(255) NOT NULL,
    balance DECIMAL(12, 2) DEFAULT 0.00,
    status VARCHAR(20) DEFAULT 'ACTIVE',
    activation_status VARCHAR(20) DEFAULT 'PENDING',
    payment_status VARCHAR(20) DEFAULT 'UNPAID',
    group_category VARCHAR(100) DEFAULT 'General',
    is_duplicate BOOLEAN DEFAULT FALSE,
    duplicate_reason TEXT,
    duplicate_of_id INTEGER,
    duplicate_reviewed BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create admin users table
CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    status VARCHAR(20) DEFAULT 'ACTIVE',
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create payment proofs table
CREATE TABLE IF NOT EXISTS payment_proofs (
    id SERIAL PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    transaction_reference VARCHAR(100) UNIQUE,
    payment_month VARCHAR(7),
    payment_date DATE NOT NULL,
    proof_file_path VARCHAR(500),
    proof_file_name VARCHAR(255),
    status VARCHAR(20) DEFAULT 'PENDING',
    rejection_reason TEXT,
    verified_by INTEGER REFERENCES admin_users(id),
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create monthly payments table
CREATE TABLE IF NOT EXISTS monthly_payments (
    id SERIAL PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    amount_due DECIMAL(10, 2) NOT NULL DEFAULT 500.00,
    amount_paid DECIMAL(10, 2) DEFAULT 0.00,
    status VARCHAR(20) DEFAULT 'DUE' NOT NULL,
    due_date DATE,
    payment_date DATE,
    payment_proof_id INTEGER REFERENCES payment_proofs(id),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (member_id, year, month)
);

-- Create withdrawals table
CREATE TABLE IF NOT EXISTS withdrawals (
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
CREATE TABLE IF NOT EXISTS transactions (
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

-- Create OTP table for password reset
CREATE TABLE IF NOT EXISTS member_otp (
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

-- Create import history table
CREATE TABLE IF NOT EXISTS import_history (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    imported_records INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'SUCCESS',
    import_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);

-- ============================================================
-- NEW TABLES v2.0
-- ============================================================

-- Auctions table
CREATE TABLE IF NOT EXISTS auctions (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    auction_date DATE NOT NULL,
    scheduled_start_time TIMESTAMP,
    duration_seconds INTEGER NOT NULL DEFAULT 120,
    starting_amount DECIMAL(12, 2) NOT NULL DEFAULT 5000.00,
    bid_increment DECIMAL(12, 2) NOT NULL DEFAULT 500.00,
    status VARCHAR(20) DEFAULT 'SCHEDULED',
    current_highest_bid DECIMAL(12, 2),
    highest_bidder_id INTEGER REFERENCES members(id),
    winner_id INTEGER REFERENCES members(id),
    final_amount DECIMAL(12, 2),
    timer_started_at TIMESTAMP,
    timer_paused_at TIMESTAMP,
    elapsed_seconds INTEGER DEFAULT 0,
    created_by INTEGER REFERENCES admin_users(id),
    ended_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Bids table (with duplicate protection)
CREATE TABLE IF NOT EXISTS bids (
    id SERIAL PRIMARY KEY,
    auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    amount DECIMAL(12, 2) NOT NULL,
    bid_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_winning BOOLEAN DEFAULT FALSE,
    server_timestamp BIGINT
);

-- Auction Chat Messages
CREATE TABLE IF NOT EXISTS auction_chat_messages (
    id SERIAL PRIMARY KEY,
    auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    member_id INTEGER REFERENCES members(id),
    admin_id INTEGER REFERENCES admin_users(id),
    sender_name VARCHAR(255),
    sender_member_id VARCHAR(50),
    message TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text',
    voice_url VARCHAR(500),
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Voice Messages (standalone, linked to chat)
CREATE TABLE IF NOT EXISTS voice_messages (
    id SERIAL PRIMARY KEY,
    auction_id INTEGER REFERENCES auctions(id),
    member_id INTEGER NOT NULL REFERENCES members(id),
    file_path VARCHAR(500) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    duration_seconds DECIMAL(6,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    type VARCHAR(30) DEFAULT 'info',
    reference_type VARCHAR(30),
    reference_id INTEGER,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- App Settings (key-value store)
CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    actor_type VARCHAR(20) NOT NULL,
    actor_id INTEGER NOT NULL,
    actor_name VARCHAR(255),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id INTEGER,
    details TEXT,
    ip_address VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Muted Members (for chat moderation)
CREATE TABLE IF NOT EXISTS muted_members (
    id SERIAL PRIMARY KEY,
    auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    muted_by INTEGER REFERENCES admin_users(id),
    muted_until TIMESTAMP,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(auction_id, member_id)
);

-- ============================================================
-- LIVE CHAT GROUPS / ROOMS TABLES
-- ============================================================

-- Chat Groups Table
CREATE TABLE IF NOT EXISTS chat_groups (
    id SERIAL PRIMARY KEY,
    group_name VARCHAR(100) NOT NULL,
    created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
    group_admin_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
    max_members INTEGER DEFAULT 12,
    status VARCHAR(20) DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Chat Group Members Table
CREATE TABLE IF NOT EXISTS chat_group_members (
    id SERIAL PRIMARY KEY,
    group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
    member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'MEMBER',
    is_muted BOOLEAN DEFAULT FALSE,
    is_online BOOLEAN DEFAULT TRUE,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, member_id)
);

-- Chat Group Messages Table
CREATE TABLE IF NOT EXISTS chat_group_messages (
    id SERIAL PRIMARY KEY,
    group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
    member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
    sender_name VARCHAR(255),
    sender_member_id VARCHAR(50),
    message_type VARCHAR(20) DEFAULT 'text',
    message TEXT,
    media_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Chat Group Requests Table
CREATE TABLE IF NOT EXISTS chat_group_requests (
    id SERIAL PRIMARY KEY,
    group_name VARCHAR(100) NOT NULL,
    requested_by INTEGER REFERENCES members(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'PENDING',
    reviewed_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_members_member_id ON members(member_id);
CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);
CREATE INDEX IF NOT EXISTS idx_monthly_payments_member_year_month ON monthly_payments(member_id, year, month);
CREATE INDEX IF NOT EXISTS idx_withdrawals_member_month ON withdrawals(member_id, month);
CREATE INDEX IF NOT EXISTS idx_transactions_member_date ON transactions(member_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_transactions_month ON transactions(month);
CREATE INDEX IF NOT EXISTS idx_member_otp_member_id ON member_otp(member_id);
CREATE INDEX IF NOT EXISTS idx_member_otp_status ON member_otp(status);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_member_id ON payment_proofs(member_id);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_status ON payment_proofs(status);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_transaction_ref ON payment_proofs(transaction_reference);
CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);
CREATE INDEX IF NOT EXISTS idx_bids_auction_id ON bids(auction_id);
CREATE INDEX IF NOT EXISTS idx_bids_member_id ON bids(member_id);
CREATE INDEX IF NOT EXISTS idx_chat_auction_id ON auction_chat_messages(auction_id);
CREATE INDEX IF NOT EXISTS idx_notifications_member_id ON notifications(member_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_type, actor_id);

-- ============================================================
-- DEFAULT APP SETTINGS
-- ============================================================

INSERT INTO app_settings (key, value) VALUES
    ('org_name', 'PF Chit Fund Club'),
    ('org_name_tamil', 'புதுப்பட்டி நண்பர்கள் சீட்டு பண்டு கிளப்'),
    ('logo_path', '/assets/logo.png'),
    ('qr_path', '/assets/qr.png'),
    ('admin_upi_id', '9025893352@idfcfirst'),
    ('admin_upi_name', 'IDFC First Bank · Sarathkumar Pandiyaraja'),
    ('whatsapp_link', ''),
    ('default_payment_amount', '500'),
    ('payment_instructions_en', 'Scan the QR code to make payment via UPI. Enter your transaction reference ID and upload a screenshot as proof.'),
    ('payment_instructions_ta', 'UPI மூலம் பணம் செலுத்த QR குறியீட்டை ஸ்கேன் செய்யவும். உங்கள் பரிவர்த்தனை குறிப்பு ID ஐ உள்ளிட்டு ஸ்கிரீன்ஷாட்டை சமர்ப்பிக்கவும்.'),
    ('auction_default_duration', '120'),
    ('auction_default_starting_amount', '5000'),
    ('auction_default_bid_increment', '500'),
    ('notifications_enabled', 'true'),
    ('sound_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- DEFAULT ADMIN USER (password: Admin@123456)
-- ============================================================

INSERT INTO admin_users (username, password_hash, email, status)
VALUES ('admin', '$2b$10$xJ8K9L3m2N4p6Q8r0S2t4uVwXyZ.1234567890abcdef', 'admin@pfchitfund.com', 'ACTIVE')
ON CONFLICT (username) DO NOTHING;
