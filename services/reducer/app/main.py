from fastapi import FastAPI

app = FastAPI(title="VectorScape Reducer", version="0.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "reducer"}
