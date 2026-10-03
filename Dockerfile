FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY src/ ./src/

# Brand/share assets (og:image for the landing page's share previews).
COPY assets/ ./assets/

# README wird unter /README.md ausgeliefert — Verzeichnisse (mcp.so) lesen daraus die
# Tool-Liste unter der Ueberschrift "## Tools". Ohne die Datei im Image gaebe es die Route nicht.
COPY README.md ./README.md

ENV WI_MCP_PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
