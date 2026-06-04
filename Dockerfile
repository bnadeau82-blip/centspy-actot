FROM apify/actor-node-playwright-chrome:20
USER root
RUN npx playwright install chromium
USER myuser
COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=dev --omit=optional
COPY --chown=myuser:myuser . ./
CMD ["node", "main.js"]
