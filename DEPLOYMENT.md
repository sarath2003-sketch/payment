# 🚀 Deployment Guide

This guide covers deploying the Amount Management System to various cloud platforms.

## 📦 Docker Deployment (Recommended)

### Prerequisites
- Docker installed
- Docker Compose installed

### Quick Start with Docker Compose

```bash
# 1. Navigate to project root
cd amount-management-system

# 2. Create .env file
cp .env.example .env

# 3. Update .env with your settings
nano .env

# 4. Build and start containers
docker-compose up -d

# 5. Application will be available at:
# Frontend: http://localhost:3000
# Backend: http://localhost:5000
# Database: localhost:5432
```

### Docker Compose Commands

```bash
# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Rebuild after code changes
docker-compose up -d --build

# Reset database
docker-compose down -v
docker-compose up -d
```

---

## ☁️ Heroku Deployment

### Prerequisites
- Heroku CLI installed
- Heroku account

### Step 1: Prepare for Heroku

```bash
# Create Procfile in root directory
echo "web: cd server && npm start" > Procfile

# Create .gitignore
echo "node_modules/" >> .gitignore
echo ".env" >> .gitignore
echo "dist/" >> .gitignore
echo "build/" >> .gitignore
```

### Step 2: Deploy Backend

```bash
# Login to Heroku
heroku login

# Create app
heroku create amount-management-api

# Add PostgreSQL
heroku addons:create heroku-postgresql:hobby-dev -a amount-management-api

# Set environment variables
heroku config:set JWT_SECRET=your-secret-key -a amount-management-api
heroku config:set ADMIN_PASSWORD=Your@Strong@Password -a amount-management-api
heroku config:set CORS_ORIGIN=https://amount-management-web.herokuapp.com -a amount-management-api

# Deploy
git push heroku main

# Run database setup
heroku run "node -e \"require('pg').query('...')\"" -a amount-management-api
```

### Step 3: Deploy Frontend

```bash
# Update API URL in client/.env
echo "REACT_APP_API_URL=https://amount-management-api.herokuapp.com/api" > client/.env

# Build frontend
cd client
npm run build
cd ..

# Create frontend app
heroku create amount-management-web

# Deploy using Heroku static buildpack
heroku buildpacks:add heroku/static -a amount-management-web

# Create static.json
cat > static.json << 'EOF'
{
  "root": "client/build",
  "routes": {
    "/**": "index.html"
  }
}
EOF

# Deploy
git push heroku main
```

---

## 🌩️ AWS Deployment

### Architecture
- **EC2**: Backend API server
- **RDS**: PostgreSQL database
- **S3 + CloudFront**: Frontend distribution

### Step 1: Setup RDS PostgreSQL

```bash
# In AWS Console:
# 1. Go to RDS → Create Database
# 2. Select PostgreSQL
# 3. Choose db.t3.micro for dev (free tier eligible)
# 4. Set Master username: admin
# 5. Set Master password: Strong@Password123
# 6. Create database
# 7. Note the endpoint (e.g., mydb.xxxx.us-east-1.rds.amazonaws.com)
```

### Step 2: Setup EC2 Instance

```bash
# Launch EC2 instance
# - Ubuntu 20.04 LTS
# - t2.micro (free tier)
# - Security group: Allow SSH (22), HTTP (80), HTTPS (443), Custom TCP 5000

# Connect to instance
ssh -i your-key.pem ubuntu@your-instance-ip

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_16.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Git
sudo apt-get install -y git

# Clone repository
git clone https://github.com/your-repo/amount-management-system.git
cd amount-management-system/server

# Install dependencies
npm install

# Create .env file
cat > .env << 'EOF'
DATABASE_URL=postgresql://admin:password@your-rds-endpoint:5432/amount_management_db
PORT=5000
JWT_SECRET=your-secret-key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=Admin@123456
CORS_ORIGIN=https://your-frontend-domain.com
EOF

# Install PM2 globally
sudo npm install -g pm2

# Start application with PM2
pm2 start index.js --name "amount-management-api"
pm2 startup
pm2 save
```

### Step 3: Setup Nginx Reverse Proxy

```bash
# Install Nginx
sudo apt-get install -y nginx

# Create Nginx config
sudo nano /etc/nginx/sites-available/default

# Add this configuration:
# server {
#     listen 80 default_server;
#     listen [::]:80 default_server;
#
#     server_name _;
#
#     location / {
#         proxy_pass http://localhost:5000;
#         proxy_http_version 1.1;
#         proxy_set_header Upgrade $http_upgrade;
#         proxy_set_header Connection 'upgrade';
#         proxy_set_header Host $host;
#         proxy_cache_bypass $http_upgrade;
#     }
# }

# Test and restart Nginx
sudo nginx -t
sudo systemctl restart nginx
```

### Step 4: Deploy Frontend to S3

```bash
# Build frontend
cd client
npm run build

# Create S3 bucket
aws s3 mb s3://amount-management-app --region us-east-1

# Enable static website hosting
aws s3api put-bucket-website \
    --bucket amount-management-app \
    --website-configuration '{
      "IndexDocument": {"Suffix": "index.html"},
      "ErrorDocument": {"Key": "index.html"}
    }'

# Upload build files
aws s3 sync build/ s3://amount-management-app --delete

# Setup CloudFront
# In AWS Console:
# 1. Go to CloudFront → Create Distribution
# 2. Origin: S3 bucket
# 3. Use CloudFront domain or attach your domain
# 4. Set default root to index.html
```

---

## 🌊 DigitalOcean Deployment

### Step 1: Create Droplet

```bash
# In DigitalOcean Console:
# 1. Create Droplet
# 2. Ubuntu 20.04
# 3. Basic Plan ($5/month)
# 4. Create VPC
```

### Step 2: Setup Droplet

```bash
# SSH into droplet
ssh root@your-droplet-ip

# Update system
apt update && apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_16.x | sudo -E bash -
apt-get install -y nodejs

# Install PostgreSQL
apt-get install -y postgresql postgresql-contrib

# Start PostgreSQL
systemctl start postgresql
systemctl enable postgresql

# Create database
sudo -u postgres psql << EOF
CREATE DATABASE amount_management_db;
CREATE USER admin WITH PASSWORD 'SecurePassword123';
ALTER ROLE admin SET client_encoding TO 'utf8';
ALTER ROLE admin SET default_transaction_isolation TO 'read committed';
ALTER ROLE admin SET default_transaction_deferrable TO on;
ALTER ROLE admin SET default_timezone TO 'UTC';
GRANT ALL PRIVILEGES ON DATABASE amount_management_db TO admin;
EOF

# Initialize schema
sudo -u postgres psql amount_management_db < schema.sql
```

### Step 3: Deploy Application

```bash
# Clone repo
git clone your-repo
cd amount-management-system/server

# Install dependencies
npm install

# Create .env
cat > .env << 'EOF'
DATABASE_URL=postgresql://admin:SecurePassword123@localhost:5432/amount_management_db
PORT=5000
JWT_SECRET=change-this-key
ADMIN_PASSWORD=Admin@123456
CORS_ORIGIN=https://your-domain.com
EOF

# Install PM2
npm install -g pm2

# Start app
pm2 start index.js
pm2 startup
pm2 save

# Install Nginx
apt-get install -y nginx

# Configure Nginx (same as AWS)
# Then enable SSL with Let's Encrypt
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

---

## 🔐 SSL/HTTPS Setup

### Using Let's Encrypt (Free)

```bash
# Install Certbot
sudo apt-get install -y certbot python3-certbot-nginx

# Get certificate
sudo certbot certonly --standalone -d your-domain.com

# Configure Nginx
sudo nano /etc/nginx/sites-available/default

# Add SSL config:
# server {
#     listen 443 ssl;
#     ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
#     ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
#     ...
# }

# Redirect HTTP to HTTPS:
# server {
#     listen 80;
#     return 301 https://$server_name$request_uri;
# }

sudo systemctl restart nginx

# Auto-renewal
sudo certbot renew --dry-run
```

---

## 📊 Database Backup

### Heroku PostgreSQL Backup

```bash
# Create backup
heroku pg:backups:capture -a amount-management-api

# List backups
heroku pg:backups -a amount-management-api

# Download backup
heroku pg:backups:download -a amount-management-api
```

### Manual PostgreSQL Backup

```bash
# Backup database
pg_dump -U admin amount_management_db > backup.sql

# Restore database
psql -U admin amount_management_db < backup.sql

# Backup schedule with cron
# 0 2 * * * pg_dump -U admin amount_management_db > /backups/amount_mgmt_$(date +\%Y\%m\%d).sql
```

---

## 🔧 Monitoring & Maintenance

### Check Application Status

```bash
# PM2 status
pm2 status

# View logs
pm2 logs amount-management-api

# Monitor in real-time
pm2 monit
```

### Database Maintenance

```bash
# Connect to database
psql -U admin -h localhost amount_management_db

# View database size
SELECT pg_size_pretty(pg_database_size('amount_management_db'));

# Vacuum and analyze
VACUUM ANALYZE;
```

---

## 📈 Performance Optimization

### Enable Query Caching

```bash
# Edit PostgreSQL config
sudo nano /etc/postgresql/12/main/postgresql.conf

# Add:
# shared_buffers = 256MB
# effective_cache_size = 1GB
# work_mem = 4MB

sudo systemctl restart postgresql
```

### Add Indexes

```sql
CREATE INDEX idx_members_status ON members(status);
CREATE INDEX idx_payments_status ON monthly_payments(status);
```

---

## 🆘 Troubleshooting

### Application won't start

```bash
# Check Node version
node --version

# Clear npm cache
npm cache clean --force

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### Database connection failed

```bash
# Test PostgreSQL connection
psql -U admin -h localhost -d amount_management_db -c "SELECT 1"

# Check environment variables
echo $DATABASE_URL
```

### Nginx 502 Bad Gateway

```bash
# Check if backend is running
curl http://localhost:5000/api/health

# Check Nginx error logs
tail -f /var/log/nginx/error.log
```

---

## 🎯 Security Checklist

- [ ] Change admin password
- [ ] Generate strong JWT_SECRET
- [ ] Enable HTTPS/SSL
- [ ] Set CORS_ORIGIN correctly
- [ ] Enable database backups
- [ ] Setup firewall rules
- [ ] Enable server monitoring
- [ ] Setup log aggregation
- [ ] Configure automatic updates
- [ ] Create SSH key-based authentication

---

## 📞 Support

For deployment issues, contact your cloud provider's support or refer to their documentation.

**Last Updated**: June 2026
