FROM jrottenberg/ffmpeg:latest

RUN apt-get update && apt-get install -y nodejs npm curl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY server.js ./

RUN mkdir -p uploads chunks

EXPOSE 8080

CMD ["node", "server.js"]