FROM node:18

RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . ./
RUN mkdir -p uploads chunks

EXPOSE 8080
CMD ["node", "index.js"]