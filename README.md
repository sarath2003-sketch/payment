# 💰 Amount Management System

A complete cloud-ready full-stack web application for managing monthly group payments and withdrawals.

## 🌟 Features

- **Dashboard**: Real-time overview of collections, withdrawals, and balances
- **Member Management**: Add, edit, and manage group members
- **Payment Tracking**: Record and track monthly payments with status and methods
- **Withdrawal Management**: Track withdrawals with reasons and notes
- **Transaction History**: Complete audit trail of all transactions
- **Reports & Analytics**: Monthly reports with charts and statistics
- **Excel Import/Export**: Bulk import data and export reports
- **Secure Admin Login**: JWT-based authentication
- **Responsive Design**: Works on desktop, tablet, and mobile devices

## 📋 Tech Stack

### Backend
- **Node.js** with Express.js
- **PostgreSQL** database
- **JWT** authentication
- **Multer** for file uploads
- **XLSX** for Excel processing

### Frontend
- **React** 18+
- **React Router** for navigation
- **Recharts** for charts and analytics
- **Axios** for API calls
- **CSS3** for styling

## 🚀 Getting Started

### Prerequisites
- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

### 1. Clone/Download the Project
```bash
cd amount-management-system
```

### 2. Setup Database

#### On Linux/Mac:
```bash
# Connect to PostgreSQL
psql -U postgres

# Create database and tables
\i server/database/schema.sql
```

#### On Windows:
```bash
psql -U postgres -f server/database/schema.sql
```

Or create database manually:
```sql
CREATE DATABASE amount_management_db;

-- Then run the schema.sql file content
```

### 3. Setup Backend

```bash
# Navigate to root directory
cd amount-management-system

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Update .env with your database credentials
nano .env
```

**Important settings in .env:**
```
DATABASE_URL=postgresql://username:password@localhost:5432/amount_management_db
PORT=5000
JWT_SECRET=your-secret-key-change-in-production
ADMIN_USERNAME=admin
ADMIN_PASSWORD=Admin@123456
CORS_ORIGIN=http://localhost:3000
```

### 4. Setup Frontend

```bash
# Navigate to client directory
cd client

# Install dependencies
npm install

# Create .env file
echo "REACT_APP_API_URL=http://localhost:5000/api" > .env
```

### 5. Run the Application

#### Terminal 1 - Start Backend Server:
```bash
cd amount-management-system
npm start
# Server will run on http://localhost:5000
```

#### Terminal 2 - Start Frontend Development Server:
```bash
cd amount-management-system/client
npm start
# Frontend will run on http://localhost:3000
```

### 6. Login
- **URL**: http://localhost:3000
- **Username**: admin
- **Password**: Admin@123456

## 📊 Data Import

### Import Excel Data
1. Go to "Import/Export" page
2. Select your Excel file (with the same structure as your original file)
3. Click "Import File"

### Excel File Format
Expected columns:
- DATE (Excel date format)
- NAME (Member name)
- AMOUNT (Payment amount)
- SATATUS (Payment status: PAID/PENDING)
- PAYMENT MODE (UPI, Cash, Bank Transfer, etc.)
- DEBIT (Withdrawal amount, if applicable)
- CREDIT (Not used currently)
- INTEREST (Interest amount, if applicable)

## 📁 Export Data

Export data in Excel format:
- Members List
- Monthly Payments
- Withdrawals
- Complete Transaction History
- Full Report (all data in one file)

## 🔧 Configuration

### Database Connection
Edit `.env` file:
```env
DATABASE_URL=postgresql://user:password@hostname:port/dbname
```

### Security
- Change `JWT_SECRET` in production
- Use strong admin password
- Enable HTTPS in production
- Use environment variables for sensitive data

### CORS Configuration
Update `CORS_ORIGIN` in `.env`:
```env
CORS_ORIGIN=https://yourdomain.com
```

## ☁️ Cloud Deployment

### Deploy on Heroku

1. **Create Heroku app**:
```bash
heroku create your-app-name
```

2. **Add PostgreSQL addon**:
```bash
heroku addons:create heroku-postgresql:hobby-dev
```

3. **Set environment variables**:
```bash
heroku config:set JWT_SECRET=your-secret-key
heroku config:set ADMIN_PASSWORD=Your@Strong@Password
heroku config:set CORS_ORIGIN=https://your-app-name.herokuapp.com
```

4. **Create Procfile**:
```
web: npm start
```

5. **Deploy**:
```bash
git push heroku main
```

### Deploy on AWS/DigitalOcean

1. **Backend (Node.js on EC2/Droplet)**:
   - Install Node.js
   - Clone repository
   - Install dependencies: `npm install`
   - Create .env file
   - Use PM2 for process management

2. **Database (RDS PostgreSQL)**:
   - Create RDS instance
   - Update DATABASE_URL in .env
   - Run schema.sql

3. **Frontend (S3 + CloudFront / Nginx)**:
   - Build: `npm run build`
   - Deploy build files to S3
   - Configure CloudFront CDN

### Deploy on Docker

**Dockerfile (Backend)**:
```dockerfile
FROM node:16-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 5000
CMD ["npm", "start"]
```

**docker-compose.yml**:
```yaml
version: '3.8'
services:
  db:
    image: postgres:13
    environment:
      POSTGRES_DB: amount_management_db
      POSTGRES_PASSWORD: password
    volumes:
      - postgres_data:/var/lib/postgresql/data

  backend:
    build: .
    ports:
      - "5000:5000"
    environment:
      DATABASE_URL: postgresql://postgres:password@db:5432/amount_management_db
    depends_on:
      - db

volumes:
  postgres_data:
```

## 📈 Available API Endpoints

### Authentication
- `POST /api/auth/login` - Login
- `GET /api/auth/verify` - Verify token
- `POST /api/auth/logout` - Logout

### Members
- `GET /api/members` - Get all members
- `GET /api/members/:id` - Get member details
- `POST /api/members` - Create member
- `PUT /api/members/:id` - Update member
- `DELETE /api/members/:id` - Delete member

### Payments
- `GET /api/payments` - Get all payments
- `POST /api/payments` - Create payment
- `PUT /api/payments/:id` - Update payment
- `DELETE /api/payments/:id` - Delete payment

### Withdrawals
- `GET /api/withdrawals` - Get all withdrawals
- `POST /api/withdrawals` - Create withdrawal
- `PUT /api/withdrawals/:id` - Update withdrawal
- `DELETE /api/withdrawals/:id` - Delete withdrawal

### Transactions
- `GET /api/transactions` - Get transactions with filters
- `GET /api/transactions/summary/monthly` - Monthly summary
- `GET /api/transactions/member/:id/summary` - Member summary

### Dashboard
- `GET /api/dashboard/summary` - Dashboard overview
- `GET /api/dashboard/monthly-collection` - Monthly collection trend
- `GET /api/dashboard/member-stats` - Member statistics
- `GET /api/dashboard/monthly-report/:month` - Monthly report

### Import/Export
- `POST /api/import-export/import` - Import Excel file
- `GET /api/import-export/export/members` - Export members
- `GET /api/import-export/export/payments` - Export payments
- `GET /api/import-export/export/withdrawals` - Export withdrawals
- `GET /api/import-export/export/transactions` - Export transactions
- `GET /api/import-export/export/complete-report` - Export complete report

## 🔒 Security Features

- JWT-based authentication
- Environment variables for sensitive data
- CORS protection
- SQL injection prevention (using parameterized queries)
- File upload validation
- Password hashing (ready for bcrypt)

## 📱 Browser Compatibility

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
- Mobile browsers

## 🆘 Troubleshooting

### Database Connection Error
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```
**Solution**: 
- Check if PostgreSQL is running
- Verify DATABASE_URL in .env
- Ensure database exists

### CORS Error
**Solution**:
- Update `CORS_ORIGIN` in `.env`
- Restart backend server

### Port Already in Use
```bash
# Kill process on port 5000 (Unix)
lsof -ti:5000 | xargs kill -9

# Kill process on port 5000 (Windows)
netstat -ano | findstr :5000
taskkill /PID [PID] /F
```

### Import Not Working
- Ensure Excel file has correct columns
- Check file size is under 10MB
- Verify date format in Excel file

## 📝 Database Schema

### Members Table
- id (primary key)
- member_id (unique)
- name
- email
- phone
- status
- created_at
- updated_at

### Monthly Payments Table
- id (primary key)
- member_id (foreign key)
- month
- payment_date
- amount
- status (PAID/PENDING)
- payment_method
- notes
- created_at
- updated_at

### Withdrawals Table
- id (primary key)
- member_id (foreign key)
- month
- withdrawal_date
- amount
- reason
- notes
- created_at
- updated_at

### Transactions Table
- id (primary key)
- member_id (foreign key)
- transaction_date
- month
- transaction_type (PAYMENT/WITHDRAWAL)
- amount
- description
- balance_after
- created_at

### Admin Users Table
- id (primary key)
- username (unique)
- password_hash
- email
- status
- last_login
- created_at
- updated_at

## 🚀 Performance Tips

1. **Database Indexes**: Already created for common queries
2. **Pagination**: Implement on large data sets
3. **Caching**: Use Redis for frequently accessed data
4. **CDN**: Serve frontend assets from CDN
5. **API Rate Limiting**: Add rate limiting middleware

## 📄 License

This project is proprietary and confidential.

## 👨‍💻 Support

For issues or questions, please contact the development team.

---

**Version**: 1.0.0  
**Last Updated**: June 2026
