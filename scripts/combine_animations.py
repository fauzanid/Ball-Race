"""
Headless Blender script — merges multiple Mixamo FBX files into a single GLB
with one animation clip per source file.

Usage (from PowerShell):
    & "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" `
        --background --python scripts/combine_animations.py -- `
        public/models/player.glb `
        idle:models-src/Idle.fbx run:models-src/run.fbx `
        sprint:models-src/sprint.fbx walk:models-src/walk.fbx

The first arg after `--` is the output GLB path. Each remaining arg is
`<clipName>:<sourceFbx>` — the FBX is imported, its action renamed to
<clipName>, and added to the export list. The first FBX provides the
character mesh; later ones contribute only their animation data.
"""

import bpy
import sys
import os


def clear_scene():
    """Remove every object in the default scene so import is clean."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False, confirm=False)
    for collection in (bpy.data.actions, bpy.data.armatures, bpy.data.meshes, bpy.data.materials):
        for item in list(collection):
            if item.users == 0:
                collection.remove(item)


def import_fbx_grab_action(path, clip_name):
    """Import an FBX, find the new action it created, rename to clip_name,
    return that action. Skips any actions that existed before import."""
    actions_before = set(a.name for a in bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=path)
    new_actions = [a for a in bpy.data.actions if a.name not in actions_before]
    if not new_actions:
        # Mixamo FBX without animation — skip rename.
        return None
    # Pick the longest action (Mixamo sometimes splits into multiple)
    action = max(new_actions, key=lambda a: a.frame_range[1] - a.frame_range[0])
    action.name = clip_name
    action.use_fake_user = True
    return action


def main():
    if "--" not in sys.argv:
        print("ERROR: pass GLB_OUT and clip:fbx pairs after `--`")
        sys.exit(1)
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) < 2:
        print("ERROR: usage: combine_animations.py -- <GLB_OUT> <clip>:<fbx> [<clip>:<fbx> ...]")
        sys.exit(1)

    glb_out = os.path.abspath(args[0])
    pairs = []
    for a in args[1:]:
        if ":" not in a:
            print(f"ERROR: bad arg `{a}` — expected `clipName:path.fbx`")
            sys.exit(1)
        name, path = a.split(":", 1)
        pairs.append((name.strip(), os.path.abspath(path.strip())))

    print(f"[combine] output: {glb_out}")
    for name, path in pairs:
        print(f"  + {name}: {path}")

    clear_scene()

    # Import the first FBX (provides the mesh + first animation)
    first_name, first_path = pairs[0]
    print(f"[combine] importing base: {first_path}")
    bpy.ops.import_scene.fbx(filepath=first_path)
    actions_after_first = set(a.name for a in bpy.data.actions)
    if not actions_after_first:
        print("ERROR: no animation in first FBX")
        sys.exit(1)
    # Rename the first action to its clip name
    first_action = max(bpy.data.actions, key=lambda a: a.frame_range[1] - a.frame_range[0])
    first_action.name = first_name
    first_action.use_fake_user = True

    # Find the imported armature so subsequent FBX animations can be retargeted
    armature = next((o for o in bpy.context.scene.objects if o.type == 'ARMATURE'), None)
    if not armature:
        print("ERROR: no armature in first FBX")
        sys.exit(1)

    # Import each remaining FBX, grab its action, then delete the duplicate
    # mesh/armature objects it brings (we only want the animation track).
    for name, path in pairs[1:]:
        print(f"[combine] importing {name}: {path}")
        before_objs = set(o.name for o in bpy.context.scene.objects)
        action = import_fbx_grab_action(path, name)
        # Delete every object the new import added — we keep only its action
        new_objs = [o for o in bpy.context.scene.objects if o.name not in before_objs]
        if new_objs:
            bpy.ops.object.select_all(action='DESELECT')
            for o in new_objs:
                o.select_set(True)
            bpy.ops.object.delete(use_global=False, confirm=False)
        if action:
            print(f"  action `{name}`  ({action.frame_range[1] - action.frame_range[0]:.1f} frames)")
        else:
            print(f"  WARN: no action found in {path}")

    # Make sure every action has a fake-user so the glTF exporter keeps it
    for action in bpy.data.actions:
        action.use_fake_user = True

    print(f"[combine] actions in scene: {[a.name for a in bpy.data.actions]}")

    os.makedirs(os.path.dirname(glb_out), exist_ok=True)

    print(f"[combine] exporting {glb_out}")
    bpy.ops.export_scene.gltf(
        filepath=glb_out,
        export_format='GLB',
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_force_sampling=True,
        export_def_bones=False,
        export_apply=False,
        export_yup=True,
        export_image_format='JPEG',
        export_image_quality=70,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=10,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_draco_color_quantization=10,
        export_draco_generic_quantization=12,
    )
    print(f"[combine] DONE: {glb_out}")


if __name__ == "__main__":
    main()
