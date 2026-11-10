import * as THREE from 'three';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const video = document.getElementById('webcam');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const statusElement = document.getElementById('status');

let handLandmarker = undefined;
let webcamRunning = false;
let lastVideoTime = -1;
let results = undefined;

// Three.js Globals
let scene, camera, renderer;
let cube;
let isGrabbing = false;
let previousHandPosition = new THREE.Vector3();
let previousWristRotation = new THREE.Quaternion();

// Interaction Parameters
const PINCH_THRESHOLD = 0.08; // Distance between thumb and index
const MOVEMENT_SPEED = 5; // Multiplier for hand movement
const SMOOTHING_FACTOR = 0.2; // Lerp factor for smooth movement

// Initialize MediaPipe HandLandmarker
const createHandLandmarker = async () => {
    try {
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
                delegate: "GPU"
            },
            runningMode: "VIDEO",
            numHands: 1
        });
        statusElement.innerText = "Model Loaded. Starting Camera...";
        enableCam();
    } catch (error) {
        statusElement.innerText = "Error loading model: " + error;
        console.error(error);
    }
};

// Enable Webcam
const enableCam = () => {
    if (!handLandmarker) {
        console.log("Wait! handLandmarker not loaded yet.");
        return;
    }

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({
            video: {
                width: 1280,
                height: 720
            }
        }).then((stream) => {
            video.srcObject = stream;
            video.addEventListener("loadeddata", predictWebcam);
            statusElement.innerText = "Hand Tracking Active";
            statusElement.style.color = "#00ff88";
            webcamRunning = true;
        });
    }
};

// Three.js Setup
function initThreeJS() {
    const container = document.getElementById('canvas-container');

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x222222);

    // Camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 5;

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x404040, 2); // Soft white light
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    // Object (Cube)
    const geometry = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    const material = new THREE.MeshStandardMaterial({
        color: 0x0077ff,
        roughness: 0.5,
        metalness: 0.5
    });
    cube = new THREE.Mesh(geometry, material);
    scene.add(cube);

    // Handle Window Resize
    window.addEventListener('resize', onWindowResize, false);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Main Loop
async function predictWebcam() {
    // Resize canvas to match video
    canvasElement.style.width = video.videoWidth;
    canvasElement.style.height = video.videoHeight;
    canvasElement.width = video.videoWidth;
    canvasElement.height = video.videoHeight;

    if (lastVideoTime !== video.currentTime) {
        lastVideoTime = video.currentTime;
        results = handLandmarker.detectForVideo(video, performance.now());
    }

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    if (results.landmarks && results.landmarks.length > 0) {
        const landmarks = results.landmarks[0];

        // Draw landmarks on debug canvas
        drawLandmarks(landmarks);

        // Process Interaction
        handleInteraction(landmarks);
    } else {
        // Reset state if hand lost
        isGrabbing = false;
        cube.material.color.setHex(0x0077ff);
    }

    canvasCtx.restore();

    // Render Three.js Scene
    renderer.render(scene, camera);

    if (webcamRunning) {
        window.requestAnimationFrame(predictWebcam);
    }
}

// Draw simple landmarks for debug
function drawLandmarks(landmarks) {
    canvasCtx.fillStyle = "#00FF00";
    for (const landmark of landmarks) {
        const x = landmark.x * canvasElement.width;
        const y = landmark.y * canvasElement.height;
        canvasCtx.beginPath();
        canvasCtx.arc(x, y, 5, 0, 2 * Math.PI);
        canvasCtx.fill();
    }
}

// Core Interaction Logic
function handleInteraction(landmarks) {
    // 1. Pinch Detection (Thumb Tip 4 & Index Tip 8)
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];
    const distance = Math.sqrt(
        Math.pow(thumbTip.x - indexTip.x, 2) +
        Math.pow(thumbTip.y - indexTip.y, 2) +
        Math.pow(thumbTip.z - indexTip.z, 2)
    );

    // Check if pinching
    if (distance < PINCH_THRESHOLD) {
        if (!isGrabbing) {
            isGrabbing = true;
            cube.material.color.setHex(0xff0055); // Change color on grab
        }
    } else {
        if (isGrabbing) {
            isGrabbing = false;
            cube.material.color.setHex(0x0077ff); // Reset color
        }
    }

    // 2. Movement (Map hand center to 3D space)
    // Using Index MCP (5) as a stable center point or average of wrist and middle finger
    const handCenter = landmarks[9]; // Middle Finger MCP

    // Map normalized coordinates (0-1) to Three.js world coordinates
    // Note: Video x is flipped (0 is left, 1 is right), but we mirrored the video element.
    // However, MediaPipe returns normalized coordinates relative to the image.
    // x: 0 (left) -> 1 (right), y: 0 (top) -> 1 (bottom)

    // We want:
    // x: 0.5 -> 0
    // x: 0 -> -Width
    // x: 1 -> +Width

    const targetX = (0.5 - handCenter.x) * MOVEMENT_SPEED * 3; // Invert X for mirror effect
    const targetY = (0.5 - handCenter.y) * MOVEMENT_SPEED * 2; // Invert Y because 3D Y is up

    // Z-depth estimation (optional, using wrist z or scale)
    // Simple approach: fixed Z or mapped from hand size
    const targetZ = 0;

    if (isGrabbing) {
        // Smoothly interpolate position
        cube.position.x += (targetX - cube.position.x) * SMOOTHING_FACTOR;
        cube.position.y += (targetY - cube.position.y) * SMOOTHING_FACTOR;
        // cube.position.z += (targetZ - cube.position.z) * SMOOTHING_FACTOR;
    }

    // 3. Rotation (Wrist Orientation)
    // Calculate vector from Wrist (0) to Middle Finger MCP (9)
    const wrist = landmarks[0];
    const middleMCP = landmarks[9];

    const dx = middleMCP.x - wrist.x;
    const dy = middleMCP.y - wrist.y;

    // Calculate angle
    const rotationZ = Math.atan2(dy, dx); // Rotation around Z axis (roll)

    // Apply rotation if grabbing
    if (isGrabbing) {
        // Offset by 90 degrees (PI/2) because hand pointing up is usually 0 rotation visually
        const targetRotation = -rotationZ - Math.PI / 2;

        // Smooth rotation
        // Simple lerp for scalar rotation
        cube.rotation.z += (targetRotation - cube.rotation.z) * SMOOTHING_FACTOR;

        // Optional: X/Y rotation based on hand tilt (palm normal) - more complex
        // For now, Z-rotation (steering wheel style) is intuitive

        // Add a little idle rotation
        cube.rotation.x += 0.01;
        cube.rotation.y += 0.01;
    } else {
        // Idle animation
        cube.rotation.x += 0.01;
        cube.rotation.y += 0.01;
    }
}

// Start Application
initThreeJS();
createHandLandmarker();
