FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY . .

# Create uploads directory
RUN mkdir -p uploads logs

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "const port = process.env.PORT || 5000; require('http').get('http://localhost:' + port + '/health', (r) => { if (r.statusCode !== 200) process.exit(1); })"

# Start application
CMD ["npm", "start"]
