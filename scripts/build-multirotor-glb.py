"""Build public/models/multirotor.glb, an original quadcopter for God's Eye (GEN-415).

Conventions (public/models/README.md): metres, glTF +Y up, nose toward local -X, origin at the
bounding-box centre. Blender is Z up; the exporter's +Y-up conversion keeps X, so the nose is -X here.
Run with Blender 5:
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
    -P scripts/build-multirotor-glb.py -- public/models/multirotor.glb [preview.png]
"""
import math
import sys

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
out_glb, out_png = args[0], (args[1] if len(args) > 1 else None)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
for block in (bpy.data.meshes, bpy.data.materials):
    for item in list(block):
        block.remove(item)


def material(name, rgb, *, metallic=0.0, roughness=0.5, alpha=1.0, emission=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*rgb, 1.0)
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Roughness"].default_value = roughness
    p.inputs["Alpha"].default_value = alpha
    if emission:
        p.inputs["Emission Color"].default_value = (*emission, 1.0)
        p.inputs["Emission Strength"].default_value = strength
    if alpha < 1.0:
        if hasattr(m, "surface_render_method"):
            m.surface_render_method = "BLENDED"
        if hasattr(m, "blend_method"):
            m.blend_method = "BLEND"
    return m


def srgb(hex_):
    def lin(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return tuple(lin(int(hex_[i:i + 2], 16)) for i in (0, 2, 4))


BODY = material("body", srgb("4b4f55"), roughness=0.5)
COVER = material("cover", srgb("5f646a"), roughness=0.4)
GLASS = material("sensor-glass", srgb("0b0c0e"), roughness=0.12, metallic=0.2)
CARBON = material("carbon", srgb("1d1e20"), roughness=0.35, metallic=0.1)
MOTOR = material("motor", srgb("2a2b2e"), metallic=0.7, roughness=0.3)
BELL = material("motor-bell", srgb("9a9da2"), metallic=0.9, roughness=0.25)
PROP = material("prop-blur", srgb("1a1a1a"), roughness=0.6, alpha=0.22)
HUB = material("prop-hub", srgb("111111"), roughness=0.4)
GEAR = material("gear", srgb("3a3d42"), roughness=0.5)
GIMBAL = material("gimbal", srgb("26282b"), roughness=0.35)
LENS = material("lens", srgb("0a1420"), roughness=0.05, metallic=0.2)
GPS = material("gps", srgb("d9dbde"), roughness=0.5)
RED = material("nav-red", srgb("ff2a1a"), emission=srgb("ff2a1a"), strength=6.0)
GREEN = material("nav-green", srgb("1aff4a"), emission=srgb("1aff4a"), strength=6.0)
WHITE = material("nav-white", srgb("ffffff"), emission=srgb("ffffff"), strength=4.0)

parts = []


def finish(obj, mat, *, bevel=0.0, segments=3, smooth=True):
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = "ANGLE"
        with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    if smooth:
        with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj],
                                       selected_editable_objects=[obj]):
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
    parts.append(obj)
    return obj


def box(size, loc, mat, *, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.active_object
    obj.scale = size
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj],
                                   selected_editable_objects=[obj]):
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, mat, bevel=bevel)


def cylinder(radius, depth, loc, mat, *, rotation=(0, 0, 0), vertices=32, bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, location=loc, rotation=rotation,
                                        vertices=vertices)
    return finish(bpy.context.active_object, mat, bevel=bevel, segments=2)


def between(p1, p2, radius, mat, vertices=16):
    a, b = Vector(p1), Vector(p2)
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=d.length, location=(a + b) / 2, vertices=vertices)
    obj = bpy.context.active_object
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d)
    return finish(obj, mat)


def sphere(radius, loc, mat, segments=24):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=loc, segments=segments, ring_count=segments // 2)
    return finish(bpy.context.active_object, mat)


# The fuselage: a bevelled core, a lighter top cover, a dark sensor window on the nose (-X), a GPS puck.
box((0.24, 0.13, 0.06), (0, 0, 0), BODY, bevel=0.02)
box((0.17, 0.10, 0.025), (0.01, 0, 0.038), COVER, bevel=0.011)
box((0.012, 0.075, 0.022), (-0.117, 0, 0.002), GLASS, bevel=0.004)
cylinder(0.024, 0.012, (0.035, 0, 0.056), GPS, vertices=40, bevel=0.003)

# Four arms in an X, motors at 0.26 m; the front pair (-X) carries the nav lights: red to port
# (the drone's left, -Y when its nose is -X), green to starboard.
R = 0.26
for deg in (45, 135, 225, 315):
    a = math.radians(deg)
    ux, uy = math.cos(a), math.sin(a)
    between((0.05 * ux, 0.05 * uy, 0.0), ((R - 0.012) * ux, (R - 0.012) * uy, 0.0), 0.011, CARBON)
    x, y = R * ux, R * uy
    cylinder(0.017, 0.022, (x, y, -0.006), CARBON, vertices=24)              # motor mount
    cylinder(0.021, 0.03, (x, y, 0.014), MOTOR, vertices=32, bevel=0.002)     # stator can
    cylinder(0.018, 0.006, (x, y, 0.032), BELL, vertices=32)                  # bell
    cylinder(0.008, 0.008, (x, y, 0.039), HUB, vertices=16)                   # prop hub
    cylinder(0.115, 0.002, (x, y, 0.040), PROP, vertices=64, bevel=0.0)       # spinning-prop blur
    if x < 0:
        sphere(0.0065, (x, y, -0.02), RED if y < 0 else GREEN, segments=16)
    else:
        sphere(0.005, (x, y, -0.02), WHITE, segments=16)

# Landing gear: splayed legs to two skids.
for side in (-1, 1):
    for x in (-0.06, 0.06):
        between((x, side * 0.045, -0.028), (x, side * 0.085, -0.1), 0.006, GEAR, vertices=12)
    between((-0.11, side * 0.085, -0.1), (0.11, side * 0.085, -0.1), 0.007, GEAR, vertices=12)

# A gimbal camera under the nose, its lens toward -X.
box((0.03, 0.04, 0.026), (-0.075, 0, -0.042), GIMBAL, bevel=0.006)
sphere(0.022, (-0.088, 0, -0.066), GIMBAL)
cylinder(0.011, 0.008, (-0.11, 0, -0.066), LENS, rotation=(0, math.pi / 2, 0), vertices=24)

# One mesh, origin at the bounding-box centre, transforms applied.
bpy.ops.object.select_all(action="DESELECT")
for obj in parts:
    obj.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
drone = bpy.context.active_object
drone.name = "multirotor"
bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
drone.location = (0, 0, 0)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
dims = drone.dimensions
print(f"DIMENSIONS x={dims.x:.3f} y={dims.y:.3f} z={dims.z:.3f} tris={sum(len(p.vertices) - 2 for p in drone.data.polygons)}")

bpy.ops.export_scene.gltf(filepath=out_glb, export_format="GLB", use_selection=True, export_yup=True,
                          export_apply=True, export_cameras=False, export_lights=False)

if not out_png:
    sys.exit(0)

# A preview: three-quarter view from the front left and above, under a sun.
scene = bpy.context.scene
for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
scene.render.resolution_x, scene.render.resolution_y = 900, 560
scene.render.film_transparent = False
world = bpy.data.worlds.new("world") if not scene.world else scene.world
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.6, 0.66, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(30)))
bpy.context.active_object.data.energy = 4.0
bpy.ops.object.camera_add(location=(-0.75, -0.55, 0.42))
cam = bpy.context.active_object
cam.data.lens = 50
direction = Vector((0, 0, 0)) - cam.location
cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
scene.camera = cam
scene.render.filepath = out_png
bpy.ops.render.render(write_still=True)
print("WROTE", out_glb, out_png)
