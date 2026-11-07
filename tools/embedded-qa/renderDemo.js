/**
 * A stand-in render node for the QA host (`?render=demo`, GEN-369): every
 * request walks queued -> rendering -> transferring -> completed in a few
 * seconds and hands back the renderer's file names with frames drawn here
 * (sky over ground, the drone boxed at the centre), so the RENDER panel, its
 * status chips and the picture-in-picture can be driven without the Spark.
 * A request whose capture id ends in `-fail` fails with a reason.
 */
const STEPS = ['queued', 'rendering', 'rendering', 'transferring', 'completed'];

function frame(request, kind) {
  const width = request.observer.sensor.image_width;
  const height = request.observer.sensor.image_height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const drone = { x: width / 2 - 16, y: height / 2 - 9, w: 32, h: 18 };
  if (kind === 'labels') {
    const grey = (v) => `rgb(${v},${v},${v})`;
    ctx.fillStyle = grey(5);
    ctx.fillRect(0, 0, width, height * 0.6);
    ctx.fillStyle = grey(2);
    ctx.fillRect(0, height * 0.6, width, height * 0.4);
    ctx.fillStyle = grey(1);
    ctx.fillRect(width * 0.1, height * 0.35, width * 0.2, height * 0.25);
    ctx.fillStyle = grey(7);
    ctx.fillRect(drone.x, drone.y, drone.w, drone.h);
  } else {
    const sky = ctx.createLinearGradient(0, 0, 0, height * 0.6);
    sky.addColorStop(0, kind === 'photo' ? '#4a7fc0' : '#6a8fb0');
    sky.addColorStop(1, '#c9d9e6');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height * 0.6);
    ctx.fillStyle = kind === 'photo' ? '#6b7a4a' : '#7a7a6a';
    ctx.fillRect(0, height * 0.6, width, height * 0.4);
    ctx.fillStyle = '#8a6a4a';
    ctx.fillRect(width * 0.1, height * 0.35, width * 0.2, height * 0.25);
    ctx.fillStyle = '#202020';
    ctx.fillRect(drone.x, drone.y, drone.w, drone.h);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = `${Math.round(height / 24)}px monospace`;
    ctx.fillText(`DEMO ${kind} · ${request.capture_id}`, 24, height - 32);
  }
  return {
    drone,
    blob: new Promise((resolve) =>
      canvas.toBlob(resolve, kind === 'unreal' ? 'image/jpeg' : 'image/png'),
    ),
  };
}

export function createDemoRenderSource({ stepMs = 1500 } = {}) {
  const jobs = new Map();
  let n = 0;
  const names = (job) => {
    const id = job.id;
    return [
      `outputs/${id}.ObserverCamera.FinalImage.0000.jpeg`,
      ...(job.request.neural ? [`outputs/${id}.ObserverCamera.FinalImage.0000_neural.png`] : []),
      `outputs/${id}.main_camera.seg.0000.png`,
      `outputs/${id}.main_camera.multilayer.0000.exr`,
      'outputs/output.json',
    ];
  };
  return {
    async submit(request) {
      const id = `demo-${++n}-${Date.now().toString(36)}`;
      jobs.set(id, { id, request, at: Date.now() });
      return { id };
    },
    async status(id) {
      const job = jobs.get(id);
      if (!job) return { state: 'failed', reason: 'this demo job is from another page load' };
      const step = STEPS[Math.min(STEPS.length - 1, Math.floor((Date.now() - job.at) / stepMs))];
      if (step === 'completed' && job.request.capture_id.endsWith('-fail'))
        return { state: 'failed', reason: 'demo: the renderer refused the shot' };
      return { state: step };
    },
    async outputs(id) {
      return names(jobs.get(id)).map((name, index) => ({ id: `o${index}`, name }));
    },
    async download(id, outputId) {
      const job = jobs.get(id);
      const name = names(job)[Number(outputId.slice(1))];
      if (name.endsWith('output.json')) {
        const { drone } = frame(job.request, 'unreal');
        const { image_width: width, image_height: height } = job.request.observer.sensor;
        return new Blob([
          JSON.stringify({
            frame_records: [
              {
                camera_intrinsics: { width, height },
                annotations: {
                  objects: [
                    {
                      kind: 'bounding_box_2d',
                      class_label: 'drone',
                      object_id: 'drone_0',
                      visible_px: drone.w * drone.h,
                      box_2d: { x_min: drone.x, y_min: drone.y, x_max: drone.x + drone.w, y_max: drone.y + drone.h },
                    },
                  ],
                },
              },
            ],
          }),
        ]);
      }
      const kind = name.includes('_neural') ? 'photo' : name.includes('.seg.') ? 'labels' : 'unreal';
      return frame(job.request, kind).blob;
    },
  };
}
