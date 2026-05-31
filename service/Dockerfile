# Backend read-service for Cloud Run. Frontend stays static on GitHub Pages;
# this Python service runs in the cloud and is the only holder of the Alpaca keys.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Cloud Run provides $PORT (defaults to 8080). Scale-to-zero keeps it free when idle.
ENV PORT=8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
