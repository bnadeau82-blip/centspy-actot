FROM apify/actor-node-playwright-chrome:20
COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=dev --omit=optional
RUN npx playwright install chromium
COPY --chown=myuser:myuser . ./
CMD ["node", "main.js"]
