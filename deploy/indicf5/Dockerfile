FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime

RUN pip install --no-cache-dir \
      transformers>=4.44 \
      soundfile \
      numpy \
      huggingface_hub

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 8080
CMD ["python", "-u", "/app/server.py"]
