# mypy: disable - error - code = "no-untyped-def,misc"
import pathlib
import io
from fastapi import FastAPI, Request, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
# Hypothetical import for LangGraph state retrieval - this might need adjustment
# from langgraph.checkpoint import get_thread_state
import fastapi.exceptions

# Define the FastAPI app
app = FastAPI()


def create_frontend_router(build_dir="../frontend/dist"):
    """Creates a router to serve the React frontend.

    Args:
        build_dir: Path to the React build directory relative to this file.

    Returns:
        A Starlette application serving the frontend.
    """
    build_path = pathlib.Path(__file__).parent.parent.parent / build_dir
    static_files_path = build_path / "assets"  # Vite uses 'assets' subdir

    if not build_path.is_dir() or not (build_path / "index.html").is_file():
        print(
            f"WARN: Frontend build directory not found or incomplete at {{build_path}}. Serving frontend will likely fail."
        )
        # Return a dummy router if build isn't ready
        from starlette.routing import Route

        async def dummy_frontend(request):
            return Response(
                "Frontend not built. Run 'npm run build' in the frontend directo
ry.",
                media_type="text/plain",
                status_code=503,
            )

        return Route("/{{path:path}}", endpoint=dummy_frontend)

    build_dir = pathlib.Path(build_dir)

    react = FastAPI(openapi_url="")
    react.mount(
        "/assets", StaticFiles(directory=static_files_path), name="static_assets
"
    )

    @react.get("/{{path:path}}")
    async def handle_catch_all(request: Request, path: str):
        fp = build_path / path
        if not fp.exists() or not fp.is_file():
            fp = build_path / "index.html"
        return fastapi.responses.FileResponse(fp)

    return react


@app.get("/download_biography/{thread_id}")
async def download_biography(thread_id: str):
    # TODO: Implement actual state retrieval logic using LangGraph's persistence layer.
    # This is a placeholder for how one might access the state.
    # The exact method depends on how LangGraph is configured and its state persistence API.
    # For example, if a Postgres checkpointer is used, we might need to query it.
    # Or, LangServe might offer a utility to get the state of a thread.

    # Hypothetical state retrieval:
    # assistant_state = get_thread_state("agent", thread_id) # "agent" is the assistant_id
    # biography_text = assistant_state.get("values", {}).get("biography_content") if assistant_state else None

    # For now, using placeholder content until state retrieval is finalized:
    biography_text = f"Biography for thread {thread_id}:\n\nThis is placeholder biography content."
    # In a real implementation, if biography_text is None or empty, return a 404 or appropriate error.
    if not biography_text:
        return Response(content="Biography not found or not yet generated for this thread.", status_code=404)

    file_name = f"biography_{thread_id}.md"

    # Create an in-memory text stream
    stream = io.StringIO(biography_text)

    return StreamingResponse(
        iter([stream.read()]), # Read the whole string to send it
        media_type="text/markdown",
        headers={
            "Content-Disposition": f"attachment; filename={file_name}"
        }
    )

# Mount the frontend under /app to not conflict with the LangGraph API routes
app.mount(
    "/app",
    create_frontend_router(),
    name="frontend",
)
