import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// --- CONFIGURATION ---
const config = {
    cubeSize: 1.5,
    cubeColor: 0x00f3ff,
    bloomStrength: 1.5,
    bloomRadius: 0.4,
    bloomThreshold: 0.1,
    lerpFactor: 0.1, // Smoothness
};

// --- STATE ---
const state = {
    isPinching: false,
    handPosition: new THREE.Vector3(0, 0, 0), // Normalized screen coords (x: -1 to 1, y: -1 to 1, z: 0 to 1)
    cubeTargetPos: new THREE.Vector3(0, 0, -5),
    cubeTargetRot: new THREE.Euler(0, 0, 0),
    cubeTargetScale: new THREE.Vector3(1, 1, 1),
};

// --- THREE.JS SETUP ---
const scene = new THREE.Scene();
// No background color - we want transparency for AR look
// scene.background = new THREE.Color(0x000000); 

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 5;

const canvas = document.getElementById('output-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ReinhardToneMapping;

// --- POST PROCESSING (BLOOM) ---
const renderScene = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
bloomPass.threshold = config.bloomThreshold;
bloomPass.strength = config.bloomStrength;
bloomPass.radius = config.bloomRadius;

const outputPass = new OutputPass();

const composer = new EffectComposer(renderer);
composer.addPass(renderScene);
composer.addPass(bloomPass);
composer.addPass(outputPass);

// --- LIGHTING ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const pointLight = new THREE.PointLight(config.cubeColor, 20, 100);
pointLight.position.set(5, 5, 5);
scene.add(pointLight);

const pointLight2 = new THREE.PointLight(0xff00ff, 20, 100); // Purple accent
pointLight2.position.set(-5, -5, 5);
scene.add(pointLight2);

// --- OBJECTS ---
// Create a "Voxel" style cube.
// We'll use a Group to hold main cube + wireframe or sub-cubes.
const cubeGroup = new THREE.Group();
scene.add(cubeGroup);

// Main Core
const geometry = new THREE.BoxGeometry(config.cubeSize, config.cubeSize, config.cubeSize);
const material = new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: config.cubeColor,
    emissiveIntensity: 0.5,
    roughness: 0.4,
    metalness: 0.8,
    transparent: true,
    opacity: 0.9
});
const coreCube = new THREE.Mesh(geometry, material);
cubeGroup.add(coreCube);

// Voxel/Tech Edge Overlay (Wireframe)
const edges = new THREE.EdgesGeometry(geometry);
const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });
const wireframe = new THREE.LineSegments(edges, lineMaterial);
cubeGroup.add(wireframe);

// Floating Particles/Sub-voxels (Optional Aesthetic)
const particleGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
const particleMat = new THREE.MeshBasicMaterial({ color: config.cubeColor });
for (let i = 0; i < 8; i++) { // Corners
    const p = new THREE.Mesh(particleGeo, particleMat);
    const offset = config.cubeSize / 2 + 0.1;
    p.position.set(
        (Math.random() - 0.5) * 2 * offset,
        (Math.random() - 0.5) * 2 * offset,
        (Math.random() - 0.5) * 2 * offset
    );
    cubeGroup.add(p);
}

// Initial Position
cubeGroup.position.copy(state.cubeTargetPos);

// --- RESIZE HANDLER ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

// --- ANIMATION LOOP ---
function animate() {
    requestAnimationFrame(animate);

    // Idle rotation if not interacting
    if (!state.isPinching) {
        cubeGroup.rotation.x += 0.005;
        cubeGroup.rotation.y += 0.005;
    } else {
        // --- MOVEMENT LOGIC (Lerp for smooth transition) ---
        cubeGroup.position.lerp(state.cubeTargetPos, config.lerpFactor);

        // Rotation based on movement - slight tilt
        // We use MathUtils.lerp for simple scalar lerping of rotation values
        cubeGroup.rotation.z = THREE.MathUtils.lerp(cubeGroup.rotation.z, state.cubeTargetRot.z, config.lerpFactor);
        cubeGroup.rotation.y = THREE.MathUtils.lerp(cubeGroup.rotation.y, state.cubeTargetRot.y, config.lerpFactor);

        cubeGroup.scale.lerp(state.cubeTargetScale, config.lerpFactor);
    }

    // Dynamic glow pulse
    const time = Date.now() * 0.001;
    bloomPass.strength = config.bloomStrength + Math.sin(time) * 0.2;
    material.emissiveIntensity = 0.5 + Math.sin(time * 2) * 0.2;

    composer.render();
}

// --- MEDIAPIPE HANDS SETUP ---
const videoElement = document.getElementById('input-video');
const statusElement = document.getElementById('status');
const pinchIndicator = document.getElementById('pinch-indicator');
const fingertipCursor = document.getElementById('fingertip-cursor');

function onResults(results) {
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        statusElement.innerText = "Hand Detected";
        const landmarks = results.multiHandLandmarks[0];

        // 8 = Index Finger Tip, 4 = Thumb Tip
        const indexTip = landmarks[8];
        const thumbTip = landmarks[4];
        const wrist = landmarks[0];

        // Update Fingertip Cursor (Index Finger)
        const cursorX = (1 - indexTip.x) * window.innerWidth;
        const cursorY = indexTip.y * window.innerHeight;
        fingertipCursor.style.left = `${cursorX}px`;
        fingertipCursor.style.top = `${cursorY}px`;
        fingertipCursor.classList.remove('hidden');

        // Calculate Distance for Pinch (Euclidean distance in 3D landmark space)
        const distance = Math.sqrt(
            Math.pow(indexTip.x - thumbTip.x, 2) +
            Math.pow(indexTip.y - thumbTip.y, 2) +
            Math.pow(indexTip.z - thumbTip.z, 2)
        );

        // Map Hand Coordinates to 3D World
        // MediaPipe: x (0-1, left-right), y (0-1, top-bottom)
        // Three.js: x (-width to width), y (height to -height)

        // Center of pinch
        const pinchCenterX = (indexTip.x + thumbTip.x) / 2;
        const pinchCenterY = (indexTip.y + thumbTip.y) / 2;

        // Visual Marker Update (Pinch Indicator)
        // Convert normalized to screen pixels for UI overlay
        const screenX = (1 - pinchCenterX) * window.innerWidth; // Mirror effect
        const screenY = pinchCenterY * window.innerHeight;

        pinchIndicator.style.left = `${screenX}px`;
        pinchIndicator.style.top = `${screenY}px`;

        // Check Pinch Threshold
        const PINCH_THRESHOLD = 0.05; // Tunable
        if (distance < PINCH_THRESHOLD) {
            state.isPinching = true;
            pinchIndicator.classList.add('active');
            pinchIndicator.innerText = "GRAB";
            pinchIndicator.classList.remove('hidden');

            // Update Target Position
            // Map 0..1 to -10..10 (approx world bounds at z=0)
            // Flip X for mirror effect
            const targetX = (0.5 - pinchCenterX) * 15;
            const targetY = (0.5 - pinchCenterY) * 10;

            // Depth scaling based on hand size (approx distance from camera)
            // Use distance between wrist(0) and Middle Finger MCP(9) as reference for hand scale/depth
            const middleMCP = landmarks[9];
            const handSize = Math.sqrt(
                Math.pow(wrist.x - middleMCP.x, 2) +
                Math.pow(wrist.y - middleMCP.y, 2)
            );

            // Simple depth mapping: larger hand = closer = positive Z
            // Base scale is approx 0.15 for average hand at webcam distance
            const targetZ = (handSize - 0.1) * 30;

            state.cubeTargetPos.set(targetX, targetY, Math.min(Math.max(targetZ, -10), 5));

            // Interaction Rotation (Tilt based on movement)
            // Calculate velocity/delta to tilt
            const deltaX = targetX - cubeGroup.position.x;
            state.cubeTargetRot.z = -deltaX * 0.5; // Tile sideways
            state.cubeTargetRot.y = cubeGroup.rotation.y + deltaX * 0.1; // Accumulate yaw

            // Scale based on "depth" gesture - actually user asked for scale based on depth movement
            // I'm implementing it as: closer (larger hand) -> larger cube
            const scaleFactor = 1 + (state.cubeTargetPos.z + 5) * 0.1;
            state.cubeTargetScale.setScalar(Math.max(0.5, scaleFactor));

        } else {
            state.isPinching = false;
            pinchIndicator.classList.remove('active');
            pinchIndicator.innerText = "";
            pinchIndicator.classList.add('hidden');
        }

    } else {
        statusElement.innerText = "Waiting for hand...";
        state.isPinching = false;
        pinchIndicator.classList.remove('active');
        pinchIndicator.classList.add('hidden');
        fingertipCursor.classList.add('hidden');
    }
}

const hands = new Hands({
    locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }
});

hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.8,
    minTrackingConfidence: 0.8 // High confidence for smoothness
});

hands.onResults(onResults);

// Start Camera
const cameraUtils = new Camera(videoElement, {
    onFrame: async () => {
        await hands.send({ image: videoElement });
    },
    width: 640,
    height: 480
});

cameraUtils.start()
    .then(() => {
        console.log("Camera started");
    })
    .catch(err => {
        console.error("Camera error:", err);
        statusElement.innerText = "Camera Error: Check permissions";
    });

animate();

