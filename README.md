# Biznex BOS

Business Operating System for canteens and small businesses.

## Features

- Point of Sale (POS) interface
- Inventory management
- Order tracking
- User management with roles (admin/cashier)
- Discount system
- Receipt printing
- Dashboard with sales analytics

## Architecture

- **Backend**: Node.js + Express + SQLite
- **Frontend**: Vanilla JS SPA
- **Desktop**: Electron wrapper

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment:
   - Copy `.env` and update secrets
   - Default admin: username `admin`, password `admin123` (change in production)

3. Run the server:
   ```bash
   npm run start:server
   ```

4. Run the desktop app:
   ```bash
   npm start
   ```

## Deployment

### Local Desktop
- Use Electron to package for Windows/Mac/Linux

### Raspberry Pi Edge Server
1. Install Node.js ARM
2. Rebuild native modules: `npm rebuild sqlite3`
3. Use PM2: `pm2 start ecosystem.config.js`
4. Access via LAN IP

## API Documentation

- Base URL: `http://localhost:3000`
- Auth: JWT Bearer tokens
- Endpoints: See `server/server.js` for details

## Security

- JWT authentication
- Helmet security headers
- Rate limiting
- Input validation with Joi
- Bcrypt password hashing

## Monitoring

- Logs in `logs/` directory
- Health check: `GET /health`
- PM2 for process management

## Backup

Run database backup:
```bash
npm run backup:db
```

## Development

- `npm run dev:server` - Run server with nodemon
- `npm run lint` - Lint code
- `npm test` - Run tests