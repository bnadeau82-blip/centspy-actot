FROM apify/actor-node-puppeteer-chrome:20
COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=dev --omit=optional
COPY --chown=myuser:myuser . ./
CMD ["node", "main.js"]
