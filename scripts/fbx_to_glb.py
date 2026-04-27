"""
Headless Blender script — converts a Mixamo FBX into a single-action GLB.

Usage (from PowerShell):
    & "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" `
        --background --python scripts/fbx_to_glb.py -- `
        models-erc/idle.fbx public/models/player_idle.glb

The two args after `--` are the input FBX and output GLB paths.
"""

import bpy
import sys
import os


def clear_scene():
    """Remove every object in the default scene so import is clean."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False, confirm=False)
    # Also nuke orphan data blocks
    for collection in (bpy.data.actions, bpy.data.armatures, bpy.data.meshes, bpy.data.materials):
        for item in list(collection):
            if item.users == 0:
                collection.remove(item)


def main():
    # `--` divides Blender's own args from script args
    if "--" not in sys.argv:
        print("ERROR: pass FBX_IN and GLB_OUT after `--`")
        sys.exit(1)
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) < 2:
        print("ERROR: usage: fbx_to_glb.py -- <FBX_IN> <GLB_OUT>")
        sys.exit(1)
    fbx_in, glb_out = args[0], args[1]
    fbx_in = os.path.abspath(fbx_in)
    glb_out = os.path.abspath(glb_out)
    print(f"[fbx_to_glb] importing {fbx_in}")

    clear_scene()
    bpy.ops.import_scene.fbx(filepath=fbx_in)

    # Make sure every action has a fake-user so the glTF exporter keeps it
    for action in bpy.data.actions:
        action.use_fake_user = True
        print(f"  action: {action.name}  ({action.frame_range[1] - action.frame_range[0]:.1f} frames)")

    # Make sure the output directory exists
    os.makedirs(os.path.dirname(glb_out), exist_ok=True)

    # Export — Blender 4+ uses `export_animation_mode='ACTIONS'` to write each
    # action as its own glTF animation track.
    print(f"[fbx_to_glb] exporting {glb_out}")
    bpy.ops.export_scene.gltf(
        filepath=glb_out,
        export_format='GLB',
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_force_sampling=True,
        export_def_bones=False,
        export_apply=False,
        export_yup=True,
        # Texture compression — JPEG cuts a ~50 MB GLB to ~5 MB without
        # visible loss at the camera distance we render players from.
        export_image_format='JPEG',
        export_image_quality=70,
        # Mesh compression — Draco shrinks geometry by another ~3-5x.
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=10,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_draco_color_quantization=10,
        export_draco_generic_quantization=12,
    )
    print(f"[fbx_to_glb] DONE: {glb_out}")


if __name__ == "__main__":
    main()
