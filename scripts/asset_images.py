"""Decode selected image bytes; keep only normalized raster data, never paths or URLs."""
from __future__ import annotations
from io import BytesIO
import hashlib
import warnings
from asset_domain import MAX_UPLOAD, MAX_PIXELS
from task_domain import fail

MIME={'png':'image/png','jpg':'image/jpeg','webp':'image/webp'}

def decode(data):
    if not isinstance(data,bytes) or not 1<=len(data)<=MAX_UPLOAD:fail('image_size','图片必须为1字节至8 MiB',413)
    try:
        from PIL import Image, ImageOps, UnidentifiedImageError
    except ImportError:fail('image_decoder','本机未具备Pillow解码器；未接收文件',503)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error',Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as probe:
                fmt={'PNG':'png','JPEG':'jpg','WEBP':'webp'}.get(probe.format)
                w,h=probe.size
                if not fmt or not 1<=w<=4096 or not 1<=h<=4096 or w*h>MAX_PIXELS:fail('image_format','只接受4096以内PNG/JPEG/WebP静态光栅')
                if getattr(probe,'n_frames',1)!=1:fail('animation','不接收动画图片')
                probe.verify()
            with Image.open(BytesIO(data)) as image:
                image.load()
                # Bake EXIF rotation/mirroring into pixels before stripping metadata.
                # Candidate dimensions describe the displayed raster, not encoded sensor axes.
                oriented=ImageOps.exif_transpose(image);w,h=oriented.size
                rgba=oriented.convert('RGBA');transparent=rgba.getchannel('A').getextrema()[0]<255
                # Rebuild pixels: drop EXIF/ICC/text and source metadata before browser display/export.
                mode='RGB' if fmt=='jpg' else 'RGBA'
                clean=Image.frombytes(mode,rgba.size,rgba.convert(mode).tobytes())
                out=BytesIO();options={'quality':95} if fmt=='jpg' else {'lossless':True} if fmt=='webp' else {}
                clean.save(out,format={'png':'PNG','jpg':'JPEG','webp':'WEBP'}[fmt],**options);normalized=out.getvalue()
        if len(normalized)>MAX_UPLOAD:fail('image_size','规范化图片超过8 MiB',413)
        meta={'source_sha256':hashlib.sha256(data).hexdigest(),'sha256':hashlib.sha256(normalized).hexdigest(),'source_bytes':len(data),'bytes':len(normalized),'format':fmt,'mime':MIME[fmt],'width':w,'height':h,'has_transparency':transparent,'normalization':'decoded_and_reencoded_without_metadata'}
        return meta,normalized
    except (Image.DecompressionBombWarning,Image.DecompressionBombError,UnidentifiedImageError,OSError,ValueError,SyntaxError) as exc:
        from task_domain import TaskError
        if isinstance(exc,TaskError):raise
        fail('invalid_image','图片无法完整解码或不安全；未保存')

def validate(meta,spec):
    issues=[]
    for k in ('width','height','format'):
        if meta[k]!=spec[k]:issues.append(k+'不符合冻结要求')
    if spec['transparency']=='required' and not meta['has_transparency']:issues.append('未检测到透明像素')
    if spec['transparency']=='opaque' and meta['has_transparency']:issues.append('含有不允许的透明像素')
    return {'status':'failed' if issues else 'passed','issues':issues,'visual_review':'not_automatically_performed'}
