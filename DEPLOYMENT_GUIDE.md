# 🚀 BIZNEX BOS - QUICK START DEPLOYMENT GUIDE

**Latest Stable Version:** 1.0.0  
**Last Updated:** March 16, 2026  
**Security Status:** ✅ Hardened & Production-Ready

---

## ⚡ 30-SECOND QUICK START

```bash
# 1. Navigate to project
cd f:\app

# 2. Install dependencies (if not done)
npm install

# 3. Start server (development)
npm start
# or with PM2:
pm2 start ecosystem.config.js

# 4. Access
# - Backend API: http://localhost:3000
# - Health Check: http://localhost:3000/health
```

---

## 🔧 ENVIRONMENT SETUP

### Development (Default)
Create `.env` with:
```env
NODE_ENV=development
JWT_SECRET=develop-secret-256bit-min
JWT_REFRESH_SECRET=develop-refresh-secret
CORS_ORIGIN=http://localhost:3000,http://localhost:5173,file://
DB_PATH=./server/biznex.db
```

### Production
Create `.env` with:
```env
NODE_ENV=production
JWT_SECRET=<generate-strong-secret-min-64-chars>
JWT_REFRESH_SECRET=<generate-strong-secret-min-64-chars>
CORS_ORIGIN=https://yourdomain.com,https://www.yourdomain.com
DB_PATH=./server/biznex.db
FORCE_HTTPS=true
HTTPS_KEY_PATH=/path/to/server.key
HTTPS_CERT_PATH=/path/to/server.cert
HTTPS_PORT=443
```

### Generate Strong Secrets
```bash
# Run this and copy output to .env
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

---

## 📋 FOLDER STRUCTURE

```
f:\app\
├── client/                 # Frontend (HTML/CSS/JS)
├── electron-shell/        # Windows desktop app
├── rpi/                   # Raspberry Pi setup
├── server/
│   ├── server.js          # Main Express server
│   ├── biznex.db          # SQLite database (auto-created)
│   ├── routes/            # API endpoints
│   ├── middleware/        # Auth & logging
│   ├── migrations/        # Database schemas
│   └── backups/           # Database backups
├── package.json           # Dependencies
├── ecosystem.config.js    # PM2 configuration
└── .env                   # Environment config (create this)
```

---

## 🧪 TESTING

### Run All Tests
```bash
# Comprehensive workflow tests
node full-test.js

# Security audit
node security-audit.js
```

### Manual Testing
```bash
# Check server health
curl http://localhost:3000/health

# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"Admin","password":"admin123"}'

# Get products (requires token)
curl http://localhost:3000/api/products \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## 🔐 SECURITY CHECKLIST

Before going to production:

- [ ] CORS_ORIGIN set to your domain (not localhost)
- [ ] JWT secrets are 64+ character random strings
- [ ] NODE_ENV=production in .env
- [ ] FORCE_HTTPS=true if using SSL/TLS
- [ ] Database backups configured
- [ ] Firewall rules configured
- [ ] Rate limiting tested
- [ ] Admin password changed from default
- [ ] All workflow tests passing (node full-test.js)
- [ ] Security audit shows no critical issues (node security-audit.js)

---

## 🛠️ COMMON TASKS

### Create Database Backup
```bash
node server/backup-db.js
```

### Clear Database
```bash
node server/clear-db.js
# Caution: This deletes all data!
```

### Test Print Functionality
```bash
node server/test-print.js
```

### Generate Sample Orders
```bash
node server/test-orders.js
```

---

## 🚀 DEPLOYMENT OPTIONS

### Option 1: Direct Node (Small Scale)
```bash
node server/server.js
```
**Best for:** Testing, development, proof-of-concept
**Limitation:** Dies if terminal closes

### Option 2: PM2 (Recommended)
```bash
npm install -g pm2

# Start with ecosystem config
pm2 start ecosystem.config.js

# View logs
pm2 logs biznex-server

# Restart
pm2 restart biznex-server

# Stop
pm2 stop biznex-server
```
**Best for:** Production, keeps running after restart
**Features:** Auto-restart, logging, monitoring

### Option 3: Electron Desktop App
```bash
# Windows standalone executable
npm run build:win

# Output: biznex-dist/Biznex-BOS-Setup-1.0.0.exe
```

### Option 4: Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY . .
RUN npm ci --only=production
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/server.js"]
```

### Option 5: Raspberry Pi Kiosk
```bash
cd rpi
./install.sh
# Automatically starts on boot as kiosk
```

---

## 📊 API ENDPOINTS

### Authentication
- `POST /api/auth/login` - Login and get JWT
- `POST /api/auth/refresh` - Refresh JWT token

### Products
- `GET /api/products` - List products
- `POST /api/products` - Create product (Admin)
- `PUT /api/products/:id` - Update product (Admin)

### Orders
- `GET /api/orders` - List orders
- `POST /api/orders` - Create order
- `GET /api/orders/:id` - Get order details
- `GET /api/orders/:id/print` - Print receipt

### Users
- `GET /api/users` - List users (Admin)
- `POST /api/users` - Create user (Admin)

### Reports
- `GET /api/reports/sales` - Sales report
- `GET /api/reports/inventory` - Inventory report

### Settings
- `GET /api/settings` - Get business settings
- `PUT /api/settings` - Update settings (Admin)

### Health
- `GET /health` - Server health & uptime

---

## 🐛 TROUBLESHOOTING

### Port 3000 Already In Use
```bash
# Kill existing process
Get-Process node | Stop-Process -Force
# Then restart
node server/server.js
```

### Database Locked Error
```bash
# SQLite sometimes locks. Try:
rm -f server/biznex.db-journal
# Then restart server
```

### CORS Errors
```bash
# Check .env has correct CORS_ORIGIN
# Example: CORS_ORIGIN=http://localhost:3000
# Or for production: CORS_ORIGIN=https://yourdomain.com
```

### JWT Token Expired
- JWT tokens valid for 1 hour
- Use refresh endpoint to get new token
- Or login again

### Authentication Failing
- Default admin: username=`Admin`, password=`admin123`
- Change password in production!
- Check token is passed: `Authorization: Bearer YOUR_TOKEN`

---

## 📞 SUPPORT RESOURCES

### Generated Documentation
- `FINAL_HARDENING_REPORT.md` - Complete security analysis
- `FIXES_APPLIED.md` - Detailed fix descriptions
- `TEST_AND_SECURITY_REPORT.md` - Original test reports
- `QUICK_SUMMARY.txt` - Executive summary

### Test Files
- `full-test.js` - 10 comprehensive tests
- `security-audit.js` - Security configuration scanner
- `debug-products.js` - Debug API responses

### Database
- `server/backup-db.js` - Backup utilities
- `server/clear-db.js` - Database reset
- `server/migrations/` - Schema definitions

---

## 🎯 NEXT STEPS

1. **Configure Environment:**
   - Copy `.env.production` to `.env`
   - Set strong JWT secrets
   - Set CORS_ORIGIN to your domain

2. **Test Thoroughly:**
   - Run `node full-test.js`
   - Run `node security-audit.js`
   - Test with PM2 or Docker

3. **Deploy:**
   - Choose deployment option above
   - Configure backups
   - Setup monitoring

4. **Monitor:**
   - Check logs regularly: `pm2 logs biznex-server`
   - Monitor database size
   - Test backups periodically

5. **Secure:**
   - Change default admin password
   - Keep dependencies updated: `npm audit fix`
   - Setup firewall rules
   - Enable HTTPS/TLS

---

**Status:** ✅ Ready for Deployment  
**Last Tested:** March 16, 2026  
**Uptime:** Stable  
**Security:** High
