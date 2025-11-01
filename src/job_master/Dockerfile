FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
# Usar "npm run start" en el server y "npm run worker" en el worker container
CMD ["npm","run","start"]
