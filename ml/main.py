from fastapi import FastAPI, BackgroundTasks
import pipeline
app = FastAPI(title="BlueBio ML service")
status = {"state": "idle", "error": None}
def job():
    status.update(state="running", error=None)
    try: pipeline.run(); status["state"] = "done"
    except Exception as e: status.update(state="failed", error=str(e))
@app.get("/health")
def health(): return {"ok": True}
@app.get("/status")
def get_status(): return status
@app.post("/run")
def run(bg: BackgroundTasks):
    if status["state"] != "running": bg.add_task(job)
    return {"started": True}
