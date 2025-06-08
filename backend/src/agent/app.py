# mypy: disable - error - code = "no-untyped-def,misc"
import pathlib
import io
import os # For environment variables
from fastapi import FastAPI, Request, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from langgraph_postgres import PostgresSaver # Correct import for PostgresSaver
from ..graph import builder as agent_builder # Import the StateGraph builder from graph.py
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
    try:
        db_host = os.getenv("POSTGRES_HOST", "localhost")
        db_port = os.getenv("POSTGRES_PORT", "5432")
        db_user = os.getenv("POSTGRES_USER", "postgres")
        db_pass = os.getenv("POSTGRES_PASSWORD", "postgres")
        db_name = os.getenv("POSTGRES_DB", "postgres")

        conn_string = f"postgresql+psycopg://{db_user}:{db_pass}@{db_host}:{db_port}/{db_name}"

        checkpointer = PostgresSaver.from_conn_string(conn_string)
        # Assuming agent_builder is the StateGraph instance before .compile()
        # This compiled graph is specifically for state retrieval via its checkpointer
        retrieval_graph = agent_builder.compile(checkpointer=checkpointer)

        config = {"configurable": {"thread_id": thread_id}} # assistant_id might be part of thread_id or checkpointer config

        state_snapshot = await retrieval_graph.aget_state(config)

        if state_snapshot:
            biography_text = state_snapshot.values.get("biography_content")
            if biography_text:
                file_name = f"biography_{thread_id}.md"
                stream = io.StringIO(biography_text)
                return StreamingResponse(
                    iter([stream.read()]),
                    media_type="text/markdown",
                    headers={
                        "Content-Disposition": f"attachment; filename={file_name}"
                    }
                )

        return Response(content="Biography not found or not yet generated for this thread.", status_code=404)

    except Exception as e:
        print(f"Error retrieving biography: {e}") # Log the error
        return Response(content="Error retrieving biography.", status_code=500)

# Mount the frontend under /app to not conflict with the LangGraph API routes
app.mount(
    "/app",
    create_frontend_router(),
    name="frontend",
)
