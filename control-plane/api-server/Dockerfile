FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache git docker-cli
RUN npm ci --omit=dev

COPY src/ ./src/

EXPOSE 3001

CMD ["node", "src/index.js"]
