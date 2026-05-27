# Fixture for FastAPI route extraction.
# Realistic API with public + protected routes, path params, Depends().
# interlinked-tdd: exempt — fixture file consumed verbatim as a string.

from fastapi import APIRouter, Depends, FastAPI
from pydantic import BaseModel


app = FastAPI()
router = APIRouter()


def get_db():
    """Database session dependency — NOT an auth marker."""
    pass


def get_current_user():
    """Auth dependency — should be picked up by the auth-chain detector."""
    pass


class Item(BaseModel):
    name: str
    price: float


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.get("/items")
def list_items(db=Depends(get_db)):
    return []


@app.get("/items/{item_id}")
def read_item(item_id: int, db=Depends(get_db)):
    return {"id": item_id}


@app.post("/items")
def create_item(item: Item, user=Depends(get_current_user)):
    return item


@router.get("/orders/{order_id}", dependencies=[Depends(get_current_user)])
async def read_order(order_id: int):
    return {"id": order_id}


@router.delete("/orders/{order_id}")
async def delete_order(order_id: int, user=Depends(get_current_user)):
    return {}


app.include_router(router, prefix="/v1")
