import * as THREE from "three";

type Voxel = THREE.Mesh<THREE.BoxGeometry, THREE.MeshPhongMaterial, THREE.Object3DEventMap> & {
    gridPos: THREE.Vector3;
    normalizedY: number;
    scatterPos: THREE.Vector3;
    scatterRot: THREE.Euler;
    targetPos: THREE.Vector3;
    isProcessed: boolean;
};

const CUBE_PHYSICAL_SIZE: number = 3;
const MAX_VOXELS = 512;
// let targetChunks: number = 512;

const container = document.getElementById('webgl-container') as HTMLElement;

export class UploadAnimation {
    private voxels: Voxel[] = [];
    private progress: number = 0;
    private currentMode: 'receiver' | 'sender';
    private targetChunks: number
    private isPaused = false;

    private scene: THREE.Scene
    private camera: THREE.PerspectiveCamera
    private renderer: THREE.WebGLRenderer
    private clock: THREE.Clock
    private group: THREE.Group
    private skeleton: THREE.LineSegments;

    constructor(targetChunks: number, currentMode: 'receiver' | 'sender') {
        this.targetChunks = targetChunks;
        this.currentMode = currentMode;

        this.clock = new THREE.Clock();
        this.scene = new THREE.Scene();

        this.camera = new THREE.PerspectiveCamera(
            60,
            container.clientWidth / container.clientHeight,
            0.1,
            1000
        );
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.group = new THREE.Group();

        const cageGeo = new THREE.BoxGeometry(
            CUBE_PHYSICAL_SIZE,
            CUBE_PHYSICAL_SIZE,
            CUBE_PHYSICAL_SIZE
        );

        const edgeGeo = new THREE.EdgesGeometry(cageGeo);
        const cageMat = new THREE.LineBasicMaterial({
            color: 0x00f2ff,
            transparent: true,
            opacity: 0.3
        });

        this.skeleton = new THREE.LineSegments(edgeGeo, cageMat);

        this.init();
    }

    private init(): void {
        this.camera.position.z = 9;
        this.camera.position.y = 2.5;

        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.setPixelRatio(container.clientWidth / container.clientHeight);
        container.appendChild(this.renderer.domElement);

        const hLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
        this.scene.add(hLight);

        const pLight1 = new THREE.PointLight(0x00f2ff, 15, 20);
        pLight1.position.set(5, 10, 5);
        this.scene.add(pLight1);

        const pLight2 = new THREE.PointLight(0x7000ff, 15, 20);
        pLight2.position.set(-5, 0, 5);
        this.scene.add(pLight2);

        
        this.group.position.y = 2.8;
        this.scene.add(this.group);

        this.createSkeleton();
        this.updateRequestedChunks(this.targetChunks);

        // window.addEventListener('resize', this.onWindowResize, false);
        this.animate();
    }

    private createSkeleton(): void {
        this.group.add(this.skeleton);
    }

    updateRequestedChunks(val: number): void {
        this.targetChunks = val;

        const visualCount = Math.min(this.targetChunks, MAX_VOXELS);
        const res = Math.round(Math.pow(visualCount, 1 / 3));
        this.createVoxelGrid(res);
        this.progress = 0;
    }

    private createVoxelGrid(res: number): void {
        this.voxels.forEach(v => this.group.remove(v));
        this.voxels = [];

    const spacing = CUBE_PHYSICAL_SIZE / res;
    const voxelSize = spacing * 0.88;
    const voxelGeo = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
    const offset = (res - 1) * spacing / 2;

    for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
            for (let z = 0; z < res; z++) {

                const mat = new THREE.MeshPhongMaterial({
                    color: 0x22d3ee,
                    transparent: true,
                    opacity: 0.75,
                    emissive: 0x7000ff,
                    emissiveIntensity: 0.1
                });

                const v = new THREE.Mesh(voxelGeo, mat) as Voxel;

                v.gridPos = new THREE.Vector3(
                    x * spacing - offset,
                    y * spacing - offset,
                    z * spacing - offset
                );

                v.normalizedY = y / res;

                this.resetVoxel(v);
                this.group.add(v);
                this.voxels.push(v);
            }
        }
    }

    this.reSortVoxels();
    // document.getElementById('voxelLabel')!.innerText = `0/${voxels.length}`;
    }

    private reSortVoxels(): void {
    if (this.currentMode === 'sender') {
        this.voxels.sort((a, b) => b.normalizedY - a.normalizedY);
    } else {
        this.voxels.sort((a, b) => a.normalizedY - b.normalizedY);
    }
    }

    private resetVoxel(v: Voxel): void {
    v.isProcessed = false;

    const radius = 10 + Math.random() * 5;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos((Math.random() * 2) - 1);

    const randomPoint = new THREE.Vector3(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi)
    );

    const scatterRot = new THREE.Euler(
        (Math.random() - 0.5) * Math.PI * 4,
        (Math.random() - 0.5) * Math.PI * 4,
        (Math.random() - 0.5) * Math.PI * 2
    );

    v.scatterPos = randomPoint;
    v.scatterRot = scatterRot;

    const mat = v.material as THREE.MeshPhongMaterial;

    if (this.currentMode === 'receiver') {
        v.position.copy(randomPoint);
        v.rotation.copy(scatterRot);
        mat.opacity = 0.05;
        v.targetPos = v.gridPos;
    } else {
        v.position.copy(v.gridPos);
        v.rotation.set(0, 0, 0);
        mat.opacity = 0.75;
        v.targetPos = randomPoint;
    }
    }

    private startAssemblyAnimation(v: Voxel, i: number, threshold: number): void {
    const mat = v.material as THREE.MeshPhongMaterial;

    if (i < threshold) {
        v.position.lerp(v.gridPos, 0.12);

        v.rotation.x = THREE.MathUtils.lerp(v.rotation.x, 0, 0.1);
        v.rotation.y = THREE.MathUtils.lerp(v.rotation.y, 0, 0.1);
        v.rotation.z = THREE.MathUtils.lerp(v.rotation.z, 0, 0.1);

        mat.opacity = THREE.MathUtils.lerp(mat.opacity, 0.75, 0.1);

        if (!v.isProcessed) {
            mat.emissiveIntensity = 2.5;
            v.isProcessed = true;
        }

        if (mat.emissiveIntensity > 0.1) mat.emissiveIntensity -= 0.15;

    } else {
        // v.position.addScaledVector(v.position, -0.0005);
        v.rotation.y += 0.005;
        mat.opacity = THREE.MathUtils.lerp(mat.opacity, 0.05, 0.05);
    }
    }

    private startDeconstructionAnimation(v: Voxel, i: number, threshold: number): void {
    const mat = v.material as THREE.MeshPhongMaterial;

    if (i < threshold) {
        const distToTarget = v.position.distanceTo(v.scatterPos);
        const totalDist = v.gridPos.distanceTo(v.scatterPos);

        const flyProgress = 1 - (distToTarget / totalDist);
        const alpha = Math.max(0.005, flyProgress * 0.15);

        v.position.lerp(v.scatterPos, alpha);

        v.rotation.x = THREE.MathUtils.lerp(v.rotation.x, v.scatterRot.x, alpha);
        v.rotation.y = THREE.MathUtils.lerp(v.rotation.y, v.scatterRot.y, alpha);
        v.rotation.z = THREE.MathUtils.lerp(v.rotation.z, v.scatterRot.z, alpha);

        mat.opacity = THREE.MathUtils.lerp(mat.opacity, 0.05, alpha);

        if (!v.isProcessed) {
            mat.emissiveIntensity = 2.5;
            v.isProcessed = true;
        }

        if (mat.emissiveIntensity > 0.1) mat.emissiveIntensity -= 0.15;

    } else {
        v.position.lerp(v.gridPos, 0.2);
        v.rotation.set(0, 0, 0);
        mat.opacity = THREE.MathUtils.lerp(mat.opacity, 0.75, 0.1);
    }
    }

    private animate = (): void => {
    requestAnimationFrame(this.animate);

    // If paused, skip logic and rendering
    if (this.isPaused) return;

    const t = this.clock.getElapsedTime();

    this.group.rotation.y = t * 0.55;
    this.group.rotation.x = (Math.sin(t * 0.3) * 0.2) + 0.4;

    const activeCount = Math.floor((this.progress / 100) * this.voxels.length);

    this.voxels.forEach((v, i) => {
        if (this.currentMode === 'receiver') {
            this.startAssemblyAnimation(v, i, activeCount);
        } else {
            this.startDeconstructionAnimation(v, i, activeCount);
        }
    });

    this.renderer.render(this.scene, this.camera);
    }

    updateProgress(progress: number) {
        this.progress = progress;
    }

    reset(): void {
    // 🛑 Pause animation to avoid race conditions
    this.isPaused = true;

    // 🔥 Dispose all voxel meshes (VERY IMPORTANT)
    this.voxels.forEach(v => {
        this.group.remove(v);

        // dispose geometry
        v.geometry.dispose();

        // dispose material
        if (Array.isArray(v.material)) {
            v.material.forEach(m => m.dispose());
        } else {
            v.material.dispose();
        }
    });

    this.voxels = [];

    // 🔄 Reset core state
    this.progress = 0;

    // 🧱 Rebuild grid fresh
    const visualCount = Math.min(this.targetChunks, MAX_VOXELS);
    const res = Math.round(Math.pow(visualCount, 1 / 3));
    this.createVoxelGrid(res);

    // ▶️ Resume animation
    this.isPaused = false;
    }

    getIsPaused() {
        return this.isPaused;
    }

    togglePause() {
        this.isPaused = !this.isPaused;
    }

    pauseAnimation() {
        this.isPaused = true;
    }

    resumeAnimation() {
        this.isPaused = false;
    }
}

// function setMode(mode: 'receiver' | 'sender'): void {
//     currentMode = mode;
//     const isRec = mode === 'receiver';

//     document.getElementById('btnReceiver')!.classList.toggle('btn-active', isRec);
//     document.getElementById('btnSender')!.classList.toggle('btn-active', !isRec);
//     document.getElementById('statLabel')!.innerText = isRec ? 'Integrity' : 'Dissolution';
//     document.getElementById('fileName')!.innerText = isRec ? 'Receiver_Sync.sys' : 'Sender_Stream.sys';

//     resetApp();
// }