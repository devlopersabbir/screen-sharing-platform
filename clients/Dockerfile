# Stage 1: Build the app
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the code
COPY . .

# Build the app
RUN npm run build

# # Stage 2: Serve with NGINX
# FROM nginx:alpine

# # Remove default NGINX static files
# RUN rm -rf /usr/share/nginx/html/*

# # Copy built app from builder stage
# COPY --from=builder /app/dist /usr/share/nginx/html

# # Copy custom NGINX config (optional)
# # COPY nginx.conf /etc/nginx/nginx.conf

# # Expose port 80
# EXPOSE 80

# # Start NGINX server
# CMD ["nginx", "-g", "daemon off;"]
CMD ["npm", "run", "preview"]