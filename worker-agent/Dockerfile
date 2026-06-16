FROM node:20-alpine

# Install docker CLI so we could potentially use it, though dockerode uses socket
RUN apk add --no-cache docker-cli git openssh-client

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

ENV RUNNING_IN_DOCKER=true

CMD ["node", "src/index.js"]
