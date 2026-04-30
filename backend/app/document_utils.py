from __future__ import annotations

import base64
from dataclasses import dataclass, field

import pymupdf
from fastapi import HTTPException, UploadFile

from .config import PDF_TEXT_MIN_CHARS, PDF_VISION_MAX_PAGES


@dataclass
class DocumentPayload:
    filenames: list[str] = field(default_factory=list)
    text_blocks: list[str] = field(default_factory=list)
    vision_parts: list[dict[str, object]] = field(default_factory=list)


async def build_document_payload(files: list[UploadFile]) -> DocumentPayload:
    payload = DocumentPayload()

    for upload in files:
        filename = upload.filename or "upload"
        content_type = (upload.content_type or "").lower()
        file_bytes = await upload.read()
        payload.filenames.append(filename)

        if content_type.startswith("image/"):
            payload.vision_parts.append(_build_image_part(file_bytes, content_type))
            continue

        if content_type == "application/pdf" or filename.lower().endswith(".pdf"):
            pdf_payload = _extract_pdf_payload(file_bytes)
            payload.text_blocks.extend(pdf_payload.text_blocks)
            payload.vision_parts.extend(pdf_payload.vision_parts)
            continue

        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type for '{filename}'. Only images and PDFs are accepted.",
        )

    return payload


def _extract_pdf_payload(file_bytes: bytes) -> DocumentPayload:
    payload = DocumentPayload()
    with pymupdf.open(stream=file_bytes, filetype="pdf") as pdf_document:
        extracted_pages: list[str] = []
        for page in pdf_document:
            page_text = page.get_text("text").strip()
            if page_text:
                extracted_pages.append(page_text)

        combined_text = "\n\n".join(extracted_pages).strip()
        if len(combined_text) >= PDF_TEXT_MIN_CHARS:
            payload.text_blocks.append(combined_text)
            return payload

        for page_index in range(min(len(pdf_document), PDF_VISION_MAX_PAGES)):
            page = pdf_document.load_page(page_index)
            pixmap = page.get_pixmap(alpha=False)
            payload.vision_parts.append(
                _build_image_part(
                    pixmap.tobytes("png"),
                    "image/png",
                )
            )

    return payload


def _build_image_part(file_bytes: bytes, content_type: str) -> dict[str, object]:
    base64_image = base64.b64encode(file_bytes).decode("utf-8")
    data_url = f"data:{content_type};base64,{base64_image}"
    return {
        "type": "image_url",
        "image_url": {"url": data_url},
    }
