# 🚀 Quick Start Guide

Get Amount Management System running in 5 minutes!

## Prerequisites
- Node.js v14+
- PostgreSQL installed and running
- npm or yarn

## 1️⃣ Setup Database

### On Windows/Mac/Linux:

```bash
# Connect to PostgreSQL
psql -U postgres

# Create database
CREATE DATABASE amount_management_db;

# Create user and grant permissions
CREATE USER admin WITH PASSWORD 'SecurePassword123';
ALTER ROLE admin SUPERUSER;

# Exit psql
\q
```

### Import Schema:
```bash
# Navigate to project
cd amount-management-system

# Import schema (Mac/Linux)
psql -U admin -d amount_management_db < server/database/schema.sql

# Import schema (Windows)
psql -U admin -d amount_management_db -f server/database/schema.sql
```

## 2️⃣ Setup Backend

```bash
# Navigate to root
cd amount-management-system

# Create .env file
cp .env.example .env

# Edit .env (optional - defaults work for local development)
# nano .env

# Install dependencies
npm install

# Start backend server
npm start
```

**Backend running at**: http://localhost:5000

## 3️⃣ Setup Frontend

```bash
# In a new terminal, navigate to client
cd amount-management-system/client

# Install dependencies
npm install

# Start frontend
npm start
```

**Frontend running at**: http://localhost:3000

## 4️⃣ Login

- **URL**: http://localhost:3000
- **Username**: admin
- **Password**: Admin@123456

## 5️⃣ Import Sample Data

1. Go to "Import/Export" page
2. Click "Choose File"
3. Select your Excel file (JUN062026.xlsx)
4. Click "Import File"

## 🎯 What to Do Next

### Dashboard
See overview of collections, withdrawals, and balances

### Members
Add members or view their payment history

### Payments
Record monthly payments from members

### Withdrawals
Track when members take money from the group

### Transactions
View complete transaction history

### Reports
Generate monthly reports with charts

### Import/Export
- Import Excel data
- Export to Excel for backup

## 🆘 Common Issues

### Port Already in Use

```bash
# Kill port 5000 (backend)
# Mac/Linux:
lsof -ti:5000 | xargs kill -9

# Windows:
netstat -ano | findstr :5000
taskkill /PID [PID] /F
```

### Database Connection Error

Check your .env file:
```
DATABASE_URL=postgresql://admin:SecurePassword123@localhost:5432/amount_management_db
```

### Packages Not Installing

```bash
# Clear npm cache
npm cache clean --force

# Delete node_modules
rm -rf node_modules package-lock.json

# Reinstall
npm install
```

## 📱 Mobile Access

Access application from other devices:
- Replace `localhost` with your computer's IP
- Example: http://192.168.1.100:3000

## 🐳 Docker Quick Start

```bash
# Build and run with Docker
docker-compose up

# Access at http://localhost:3000
```

## 📊 Your Excel Data

The application automatically reads from your Excel file:
- Column: DATE → Transaction date
- Column: NAME → Member name
- Column: AMOUNT → Payment amount
- Column: DEBIT → Withdrawal amount
- Column: SATATUS → Payment status

## 🔄 Next Steps

1. **Add more members**: Members → Add Member
2. **Record payments**: Payments → Add Payment
3. **Track withdrawals**: Withdrawals → Add Withdrawal
4. **View analytics**: Reports → Select Month
5. **Backup data**: Import/Export → Download Reports

## 💡 Tips

- Use **Payments** page to track monthly collections
- Use **Withdrawals** page to track who took money and why
- Check **Dashboard** for quick overview
- Generate **Monthly Reports** for detailed analysis
- **Export to Excel** for record keeping

## ⚙️ Production Deployment

When ready for production, see [DEPLOYMENT.md](DEPLOYMENT.md) for:
- Docker deployment
- Heroku setup
- AWS deployment
- DigitalOcean setup
- SSL/HTTPS configuration

## 🆘 Need Help?

1. Check [README.md](README.md) for detailed documentation
2. Review [DEPLOYMENT.md](DEPLOYMENT.md) for cloud setup
3. Check application logs for errors

---

**You're all set!** 🎉

The application is ready to manage your group's payments and withdrawals!
