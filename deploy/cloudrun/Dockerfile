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

# The call page, so the service can serve its own. Without this the container
# starts, /health says fine, and there is NOTHING TO CLICK — server.js's
# serveStatic() resolves ../../../web from caller-agent/src/agent/, which did
# not exist in the image, so /live.html 404'd on a service whose whole purpose
# is a live call. Set AGENT_SERVE_WEB=0 to turn it off in production, where the
# page is served from Vercel instead.
COPY web/ ./web/

# NOT COPIED, on purpose: package.json and node_modules. The frontend's Next.js
# and React are build-time only and nothing here imports them — CI asserts that
# api/, caller-agent/src/ and shared/ import only relative paths and node:
# builtins. An `npm ci` in this image would install a frontend toolchain into a
# container that answers phone calls.

ENV PORT=8080
ENV NODE_ENV=production

# Never root. A process that terminates audio from the public internet should
# not be able to write to its own image.
USER node

EXPOSE 8080
CMD ["node", "--experimental-detect-module", "caller-agent/src/agent/main.js"]
