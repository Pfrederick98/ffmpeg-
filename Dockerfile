FROM jrottenberg/ffmpeg:latest
RUN apt-get update && apt-get install -y nodejs npm
WORKDIR /app
COPY package.json ./
RUN npm install
COPY index.js ./
RUN mkdir -p uploads chunks
EXPOSE 8080
CMD ["node", "index.js"]