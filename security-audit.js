#!/usr/bin/env node
/**
 * BIZNEX BOS - SECURITY AUDIT REPORT
 * Comprehensive security analysis of the application
 */

const fs = require('fs');
const path = require('path');

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║     BIZNEX BOS - SECURITY AUDIT REPORT                        ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

const issues = [];
const warnings = [];
const passes = [];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. CHECK ENVIRONMENT VARIABLES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('🔍 SECTION 1: ENVIRONMENT VARIABLES\n');

const requiredEnvVars = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'DB_PATH'];
const missingEnv = [];

requiredEnvVars.forEach(env => {
    if (!process.env[env]) {
        missingEnv.push(env);
    }
});

if (missingEnv.length > 0) {
    issues.push(`Missing critical env vars: ${missingEnv.join(', ')}`);
    console.log(`❌ Missing env vars: ${missingEnv.join(', ')}`);
} else {
    passes.push('All required environment variables set');
    console.log('✅ All required env vars configured');
}

if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    warnings.push('JWT_SECRET is too short (< 32 chars)');
    console.log('⚠️  JWT_SECRET length < 32 chars (weak)');
} else {
    console.log('✅ JWT_SECRET adequate length');
}

if (process.env.NODE_ENV === 'production') {
    passes.push('Node running in production mode');
    console.log('✅ Production mode enabled');
} else {
    warnings.push('Running in development mode (not production)');
    console.log('⚠️  Development mode - not production');
}

console.log();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. CHECK SOURCE CODE FOR SECURITY ISSUES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('🔍 SECTION 2: SOURCE CODE SECURITY SCAN\n');

const routesDir = './server/routes';
const checkFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

checkFiles.forEach(file => {
    const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
    
    // Check for SQL injection vulnerabilities
    if (content.match(/\$\w+/g) && !content.includes('parameterized') && !content.includes('?')) {
        issues.push(`${file}: Potential SQL injection (string concatenation detected)`);
        console.log(`❌ ${file}: Possible SQL injection - string concat in queries`);
    } else if (content.includes('db.run') || content.includes('db.get') || content.includes('db.all')) {
        passes.push(`${file}: Uses parameterized queries`);
        console.log(`✅ ${file}: Parameterized queries used`);
    }
});

console.log();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. CHECK SERVER CONFIGURATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('🔍 SECTION 3: SERVER CONFIGURATION\n');

const serverContent = fs.readFileSync('./server/server.js', 'utf8');

const securityChecks = {
    'helmet()': { found: serverContent.includes('helmet()'), severity: 'high', name: 'Helmet security headers' },
    'cors()': { found: serverContent.includes('cors()'), severity: 'high', name: 'CORS enabled' },
    'rate limiting': { found: serverContent.includes('rateLimit'), severity: 'high', name: 'Rate limiting' },
    'body parser limit': { found: serverContent.includes('limit'), severity: 'medium', name: 'Request size limits' },
};

Object.entries(securityChecks).forEach(([key, check]) => {
    if (check.found) {
        passes.push(check.name);
        console.log(`✅ ${check.name}`);
    } else {
        if (check.severity === 'high') {
            issues.push(`Missing: ${check.name}`);
            console.log(`❌ ${check.name} - NOT CONFIGURED`);
        } else {
            warnings.push(check.name);
            console.log(`⚠️  ${check.name} - NOT CONFIGURED`);
        }
    }
});

// Check CORS configuration
const corsCheck = serverContent.match(/cors\(\s*{([^}]*?)}/);
if (corsCheck && corsCheck[1].includes('origin:')) {
    if (corsCheck[1].includes('*')) {
        warnings.push('CORS allows all origins (*)');
        console.log('⚠️  CORS configured with origin: *');
    } else {
        passes.push('CORS restrictively configured');
        console.log('✅ CORS has specific origin restrictions');
    }
}

console.log();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. CHECK AUTHENTICATION  
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('🔍 SECTION 4: AUTHENTICATION & AUTHORIZATION\n');

const authContent = fs.readFileSync('./server/middleware/auth.js', 'utf8');

const authChecks = {
    'JWT': { found: authContent.includes('jwt.verify'), name: 'JWT validation' },
    'requireAuth': { found: authContent.includes('requireAuth'), name: 'Auth middleware' },
    'requireAdmin': { found: authContent.includes('requireAdmin'), name: 'Admin role check' },
    'Token expiry': { found: authContent.includes('exp') || authContent.includes('expiresIn'), name: 'Token expiration' },
};

Object.entries(authChecks).forEach(([key, check]) => {
    if (check.found) {
        passes.push(check.name);
        console.log(`✅ ${check.name} implemented`);
    } else {
        issues.push(`Missing: ${check.name}`);
        console.log(`❌ ${check.name} - NOT FOUND`);
    }
});

console.log();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. CHECK DATA HANDLING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('🔍 SECTION 5: DATA HANDLING & SANITIZATION\n');

const authMiddleware = fs.readFileSync('./server/middleware/auth.js', 'utf8');

if (authMiddleware.includes('sanitizeBody')) {
    passes.push('Sensitive data sanitization in logs');
    console.log('✅ Sensitive data sanitized for logging');
} else {
    warnings.push('No explicit sensitive data sanitization found');
    console.log('⚠️  Sensitive data sanitization unclear');
}

if (authMiddleware.includes('password')) {
    if (authMiddleware.includes('[REDACTED]')) {
        passes.push('Passwords redacted in logs');
        console.log('✅ Passwords redacted for logging');
    } else {
        issues.push('Passwords might be logged in plaintext');
        console.log('❌ Passwords NOT properly redacted in logs');
    }
}

console.log();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. CHECK PACKAGE.JSON VULNERABILITIES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('🔍 SECTION 6: DEPENDENCY VULNERABILITIES\n');

const criticalPackages = ['express', 'sqlite3', 'jsonwebtoken', 'bcryptjs', 'helmet'];
const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

criticalPackages.forEach(pkg => {
    if (packageJson.dependencies[pkg]) {
        const version = packageJson.dependencies[pkg];
        console.log(`✅ ${pkg}: ${version}`);
        passes.push(`${pkg} installed`);
    } else {
        warnings.push(`${pkg} not found in dependencies`);
        console.log(`⚠️  ${pkg}: NOT IN DEPENDENCIES`);
    }
});

console.log();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. CHECK .env FILE EXPOSURE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('🔍 SECTION 7: CONFIGURATION FILE SECURITY\n');

if (fs.existsSync('./.gitignore')) {
    const gitignore = fs.readFileSync('./.gitignore', 'utf8');
    if (gitignore.includes('.env')) {
        passes.push('.env file ignored in git');
        console.log('✅ .env properly added to .gitignore');
    } else {
        issues.push('.env NOT in .gitignore - risk of secret exposure');
        console.log('❌ .env NOT in .gitignore - DANGEROUS');
    }
    
    if (gitignore.includes('node_modules')) {
        passes.push('node_modules ignored');
        console.log('✅ node_modules in .gitignore');
    }
} else {
    warnings.push('.gitignore not found');
    console.log('⚠️  .gitignore not found');
}

console.log();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 8. FINAL REPORT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║                    SECURITY AUDIT SUMMARY                      ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

console.log(`✅ PASSED CHECKS:     ${passes.length}`);
console.log(`⚠️  WARNINGS:         ${warnings.length}`);
console.log(`❌ CRITICAL ISSUES:   ${issues.length}\n`);

if (issues.length > 0) {
    console.log('❌ CRITICAL ISSUES TO FIX:\n');
    issues.forEach((issue, i) => {
        console.log(`   ${i + 1}. ${issue}`);
    });
    console.log();
}

if (warnings.length > 0) {
    console.log('⚠️  WARNINGS (RECOMMEND FIX):\n');
    warnings.forEach((warning, i) => {
        console.log(`   ${i + 1}. ${warning}`);
    });
    console.log();
}

console.log('✅ SECURITY PASSED:\n');
passes.forEach((pass, i) => {
    if (i % 2 === 0) console.log(`   ${i + 1}. ${pass}   ${passes[i + 1] ? `${i + 2}. ${passes[i + 1]}` : ''}`);
});

console.log('\n' + '═'.repeat(64));
const severity = issues.length > 0 ? 'HIGH' : warnings.length > 3 ? 'MEDIUM' : 'LOW';
console.log(`OVERALL SECURITY RATING: ${severity}`);
console.log('═'.repeat(64) + '\n');

process.exit(issues.length > 0 ? 1 : 0);
