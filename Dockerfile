FROM node:24-alpine
WORKDIR /app
COPY package.json server.js seed.js reset-password.js ./
COPY public ./public
ENV PORT=3000
VOLUME /app/data
EXPOSE 3000
CMD ["node", "server.js"]
