# The live-call service, for Cloud Run (asia-south1).
#
# It exists because a Vercel serverless function cannot hold a WebSocket open,
# which is the single reason the browser had to record whole utterances and POST
# them — see docs/ARCHITECTURE.md §4. Everything else stays on Vercel.
#
# No build step and no dependencies: this repo is vanilla Node ESM, so the image
# is the runtime plus the source. Nothing to compile means nothing that can be
# out of sync between what was tested and what ships.
FROM node:22-alpine

WORKDIR /app

# Only what the call leg actually reads. Copying the whole repo would put the
# Vercel functions, the test suites and the design system into a container that
# never runs them.
COPY shared/ ./shared/
COPY api/_lib/ ./api/_lib/
COPY caller-agent/src/ ./caller-agent/src/
COPY caller-agent/flows/ ./caller-agent/flows/

ENV PORT=8080
ENV NODE_ENV=production

# Never root. A process that terminates audio from the public internet should
# not be able to write to its own image.
USER node

EXPOSE 8080
CMD ["node", "--experimental-detect-module", "caller-agent/src/agent/main.js"]
