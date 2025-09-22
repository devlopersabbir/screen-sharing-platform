FROM node:18-alpine

# Create and set working directory
WORKDIR /app

# Copy only package files first for better caching
COPY package*.json ./

# Install only production dependencies
RUN npm i

# Copy the rest of your application
COPY . .

# Expose port (match the one used in your code)
EXPOSE 5152

# Set environment variable for the server port
ENV PORT=5152

# Start the app
CMD ["node", "server.js"]
