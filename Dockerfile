FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM python:3.12-slim AS runtime
WORKDIR /app
ENV PYTHONUNBUFFERED=1
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r ./backend/requirements.txt
COPY backend ./backend
COPY scripts ./scripts
COPY SKILL.md ./SKILL.md
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
RUN mkdir -p /app/outputs
EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
