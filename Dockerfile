FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY web/package.json ./web/package.json
RUN npm --prefix web install
COPY . .
RUN npm run web:build
CMD ["npm", "start"]
