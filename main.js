import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'https://unpkg.com/three-mesh-bvh@0.7.0/build/index.module.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getDatabase, ref, set, onValue, update, remove, onDisconnect } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';

// ===============================
// CONFIGURACIÓN DEL JUEGO
// ===============================
const CONFIG = {
    PLAYER_SPEED: 8.0,
    JUMP_FORCE: 12.0,
    GRAVITY: -30.0,
    MOUSE_SENSITIVITY: 0.002,
    MAX_HP: 100,
    PLAYER_SPAWN: { x: 0, y: 5, z: 0 },
    ENEMY_SPAWN: { x: 10, y: 5, z: 10 },
    PLAYER_RADIUS: 0.5,
    PLAYER_HEIGHT: 1.8,
    WEAPONS: {
        1: { id: 1, name: 'SUBFUSIL', dmg: 15, fireRate: 90, mag: 30, pellets: 1, spread: 0.01, reloadTime: 1500, auto: true },
        2: { id: 2, name: 'ESCOPETA', dmg: 8, fireRate: 800, mag: 8, pellets: 8, spread: 0.08, reloadTime: 2000, auto: false }
    }
};

// ===============================
// CONFIGURACIÓN FIREBASE (¡REEMPLAZA ESTO!)
// ===============================
const firebaseConfig = {
    apiKey: "TU_API_KEY",
    authDomain: "tu-proyecto.firebaseapp.com",
    databaseURL: "https://tu-proyecto-default-rtdb.firebaseio.com",
    projectId: "tu-proyecto",
    storageBucket: "tu-proyecto.appspot.com",
    messagingSenderId: "TUS_SENDER_ID",
    appId: "TU_APP_ID"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// Estado Global
let currentUser = null;
let currentRoom = null;
let isHost = false;
let gameLoopId;

// Variables ThreeJS
let scene, camera, renderer, mapCollider;
let playerVelocity = new THREE.Vector3();
let playerOnGround = false;
let enemyMesh;
let mapMesh;

// Variables de Juego Jugador
let hp = CONFIG.MAX_HP;
let currentWeapon = CONFIG.WEAPONS[1];
let ammo = currentWeapon.mag;
let isReloading = false;
let lastFireTime = 0;
let isDead = false;

// Variables Enemigo (Sync)
let enemyHP = CONFIG.MAX_HP;
let enemyPosition = new THREE.Vector3();
let enemyRotation = new THREE.Quaternion();

// Inicialización de BVH en Three.js
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ===============================
// INTERFAZ DE USUARIO (UI)
// ===============================
const ui = {
    layer: document.getElementById('ui-layer'),
    auth: document.getElementById('auth-screen'),
    lobby: document.getElementById('lobby-screen'),
    room: document.getElementById('room-screen'),
    game: document.getElementById('game-hud'),
    end: document.getElementById('end-screen')
};

function showScreen(screenElement) {
    Object.values(ui).forEach(el => el === ui.layer ? null : el.classList.add('hidden'));
    screenElement.classList.remove('hidden');
    if(screenElement === ui.game) {
        ui.layer.style.pointerEvents = 'none';
        document.body.requestPointerLock();
    } else {
        ui.layer.style.pointerEvents = 'auto';
        document.exitPointerLock();
    }
}

// ===============================
// AUTENTICACIÓN
// ===============================
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        document.getElementById('username-display').innerText = user.email.split('@')[0];
        showScreen(ui.lobby);
    } else {
        currentUser = null;
        showScreen(ui.auth);
    }
});

document.getElementById('btn-login').onclick = () => {
    const e = document.getElementById('email').value, p = document.getElementById('password').value;
    signInWithEmailAndPassword(auth, e, p).catch(err => document.getElementById('auth-error').innerText = "Error: Verifica tus datos.");
};
document.getElementById('btn-register').onclick = () => {
    const e = document.getElementById('email').value, p = document.getElementById('password').value;
    createUserWithEmailAndPassword(auth, e, p).catch(err => document.getElementById('auth-error').innerText = "Error: Contraseña débil o correo en uso.");
};
document.getElementById('btn-logout').onclick = () => signOut(auth);

// ===============================
// LOBBY Y SALAS
// ===============================
document.getElementById('btn-create-room').onclick = () => {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    currentRoom = code;
    isHost = true;
    
    const roomRef = ref(db, `rooms/${code}`);
    set(roomRef, {
        status: 'waiting',
        host: currentUser.uid,
        players: {
            [currentUser.uid]: { name: currentUser.email.split('@')[0], ready: false, hp: CONFIG.MAX_HP }
        }
    });

    onDisconnect(roomRef).remove();
    document.getElementById('current-room-code').innerText = code;
    document.getElementById('p1-name').innerText = currentUser.email.split('@')[0];
    document.getElementById('p2-status').className = 'player-slot waiting';
    document.getElementById('p2-status').innerText = 'Jugador 2: Esperando jugador...';
    document.getElementById('btn-start-game').classList.add('hidden');
    
    listenToRoom();
    showScreen(ui.room);
};

document.getElementById('btn-join-room').onclick = () => {
    const code = document.getElementById('join-code').value.toUpperCase();
    if (code.length !== 6) return;
    
    currentRoom = code;
    isHost = false;
    
    const p2Ref = ref(db, `rooms/${code}/players/${currentUser.uid}`);
    set(p2Ref, { name: currentUser.email.split('@')[0], ready: false, hp: CONFIG.MAX_HP });
    onDisconnect(p2Ref).remove();
    
    document.getElementById('current-room-code').innerText = code;
    listenToRoom();
    showScreen(ui.room);
};

let roomListener;
function listenToRoom() {
    if (roomListener) roomListener(); // Limpiar anterior
    roomListener = onValue(ref(db, `rooms/${currentRoom}`), (snapshot) => {
        const data = snapshot.val();
        if (!data) {
            alert("Sala cerrada o desconectada.");
            showScreen(ui.lobby);
            return;
        }

        const playerIds = Object.keys(data.players);
        
        // Actualizar UI Sala
        if (!isHost && playerIds.length > 0) {
            const hostId = data.host;
            document.getElementById('p1-name').innerText = data.players[hostId]?.name || "...";
            document.getElementById('p2-status').className = 'player-slot ready';
            document.getElementById('p2-status').innerText = `Jugador 2: ${currentUser.email.split('@')[0]} (Tú)`;
        } else if (isHost && playerIds.length === 2) {
            const p2Id = playerIds.find(id => id !== currentUser.uid);
            document.getElementById('p2-status').className = 'player-slot ready';
            document.getElementById('p2-status').innerText = `Jugador 2: ${data.players[p2Id].name}`;
            document.getElementById('btn-start-game').classList.remove('hidden');
        } else if (isHost && playerIds.length < 2) {
            document.getElementById('p2-status').className = 'player-slot waiting';
            document.getElementById('p2-status').innerText = 'Jugador 2: Esperando jugador...';
            document.getElementById('btn-start-game').classList.add('hidden');
        }

        // Detectar inicio/fin de partida
        if (data.status === 'playing' && ui.room.classList.contains('hidden') === false) {
            startGame();
        }
        if (data.status === 'finished') {
            endGameUI(data.winner === currentUser.uid);
        }
    });
}

document.getElementById('btn-start-game').onclick = () => {
    update(ref(db, `rooms/${currentRoom}`), { status: 'playing' });
};

// ===============================
// MOTOR 3D & JUEGO
// ===============================
function initThreeJS() {
    if (scene) return; // Ya inicializado
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB); // Cielo

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    document.getElementById('game-container').appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(20, 50, 20);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // Cargar Mapa GLB
    const loader = new GLTFLoader();
    loader.load('./mapa.glb', (gltf) => {
        mapMesh = gltf.scene;
        scene.add(mapMesh);
        
        // Generar BVH para colisiones reales
        const geometries = [];
        mapMesh.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                const clonedGeom = child.geometry.clone();
                clonedGeom.applyMatrix4(child.matrixWorld);
                geometries.push(clonedGeom);
            }
        });
        
        // Unir geometrías para BVH general
        // Nota: para evitar dependencias extra de BufferGeometryUtils en prototipos, 
        // usaremos las mallas individuales o la escena para raycast.
        // Para BVH de jugador simularemos colisión tirando un rayo hacia abajo y alrededor.
        mapMesh.updateMatrixWorld(true);
    });

    // Mesh Enemigo (Cilindro rojo)
    const enemyGeo = new THREE.CylinderGeometry(0.5, 0.5, CONFIG.PLAYER_HEIGHT, 16);
    const enemyMat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    enemyMesh = new THREE.Mesh(enemyGeo, enemyMat);
    scene.add(enemyMesh);
    
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

function startGame() {
    initThreeJS();
    showScreen(ui.game);
    
    isDead = false;
    hp = CONFIG.MAX_HP;
    ammo = currentWeapon.mag;
    updateHUD();

    // Posiciones Spawns
    const spawn = isHost ? CONFIG.PLAYER_SPAWN : CONFIG.ENEMY_SPAWN;
    camera.position.set(spawn.x, spawn.y, spawn.z);
    playerVelocity.set(0, 0, 0);

    // Iniciar loop de red
    setInterval(sendPlayerData, 50); // Sincronizar a 20fps

    if (!gameLoopId) requestAnimationFrame(gameLoop);
}

// ===============================
// CONTROLES Y FÍSICAS
// ===============================
const keys = { w: false, a: false, s: false, d: false, space: false };
let isShooting = false;

document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'w') keys.w = true;
    if (e.key.toLowerCase() === 'a') keys.a = true;
    if (e.key.toLowerCase() === 's') keys.s = true;
    if (e.key.toLowerCase() === 'd') keys.d = true;
    if (e.code === 'Space') keys.space = true;
    if (e.key === '1') equipWeapon(1);
    if (e.key === '2') equipWeapon(2);
    if (e.key.toLowerCase() === 'r') reloadWeapon();
});
document.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === 'w') keys.w = false;
    if (e.key.toLowerCase() === 'a') keys.a = false;
    if (e.key.toLowerCase() === 's') keys.s = false;
    if (e.key.toLowerCase() === 'd') keys.d = false;
    if (e.code === 'Space') keys.space = false;
});

document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === document.body) {
        camera.rotation.y -= e.movementX * CONFIG.MOUSE_SENSITIVITY;
        camera.rotation.x -= e.movementY * CONFIG.MOUSE_SENSITIVITY;
        camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.rotation.x));
        camera.rotation.order = "YXZ";
    }
});

document.addEventListener('mousedown', (e) => { if(e.button === 0) isShooting = true; });
document.addEventListener('mouseup', (e) => { if(e.button === 0) isShooting = false; });

function updatePhysics(delta) {
    if (isDead) return;

    // Movimiento básico relativo a cámara
    const moveDir = new THREE.Vector3();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    right.y = 0; right.normalize();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    forward.y = 0; forward.normalize();

    if (keys.w) moveDir.add(forward);
    if (keys.s) moveDir.sub(forward);
    if (keys.a) moveDir.sub(right);
    if (keys.d) moveDir.add(right);
    moveDir.normalize();

    playerVelocity.x = moveDir.x * CONFIG.PLAYER_SPEED;
    playerVelocity.z = moveDir.z * CONFIG.PLAYER_SPEED;

    // Gravedad y Salto (Física simplificada Raycaster hacia abajo)
    playerVelocity.y += CONFIG.GRAVITY * delta;
    
    // Simulación de colisión básica (Para evitar atravesar suelo/paredes requeriríamos la logica completa BVH)
    // Para simplificar el prototipo de GitHub pages usando Raycast:
    let nextPos = camera.position.clone().addScaledVector(playerVelocity, delta);
    
    if (mapMesh) {
        const raycaster = new THREE.Raycaster(camera.position, new THREE.Vector3(0, -1, 0), 0, CONFIG.PLAYER_HEIGHT);
        const intersects = raycaster.intersectObject(mapMesh, true);
        if (intersects.length > 0) {
            playerOnGround = true;
            playerVelocity.y = Math.max(0, playerVelocity.y);
            camera.position.y = intersects[0].point.y + CONFIG.PLAYER_HEIGHT;
        } else {
            playerOnGround = false;
        }
    } else {
        // Fallback si no carga el mapa
        if (nextPos.y <= CONFIG.PLAYER_HEIGHT) {
            nextPos.y = CONFIG.PLAYER_HEIGHT;
            playerVelocity.y = 0;
            playerOnGround = true;
        }
    }

    if (keys.space && playerOnGround) {
        playerVelocity.y = CONFIG.JUMP_FORCE;
        playerOnGround = false;
    }

    camera.position.addScaledVector(playerVelocity, delta);
    // Altura mínima de seguridad para no caer infinitamente
    if(camera.position.y < -50) { camera.position.y = 10; playerVelocity.y = 0; }
}

// ===============================
// ARMAS Y DISPARO
// ===============================
function equipWeapon(id) {
    if (isReloading || currentWeapon.id === id) return;
    currentWeapon = CONFIG.WEAPONS[id];
    ammo = currentWeapon.mag;
    updateHUD();
}

function reloadWeapon() {
    if (isReloading || ammo === currentWeapon.mag) return;
    isReloading = true;
    document.getElementById('reload-indicator').classList.remove('hidden');
    setTimeout(() => {
        ammo = currentWeapon.mag;
        isReloading = false;
        document.getElementById('reload-indicator').classList.add('hidden');
        updateHUD();
    }, currentWeapon.reloadTime);
}

function processShooting() {
    if (!isShooting || isDead || isReloading) return;
    const now = Date.now();
    if (now - lastFireTime < currentWeapon.fireRate) return;
    if (ammo <= 0) { reloadWeapon(); return; }

    lastFireTime = now;
    ammo--;
    updateHUD();
    if (!currentWeapon.auto) isShooting = false; // Requiere soltar clic

    // Lógica de Raycast de Daño
    const raycaster = new THREE.Raycaster();
    for (let i = 0; i < currentWeapon.pellets; i++) {
        // Aplicar dispersión
        const spreadX = (Math.random() - 0.5) * currentWeapon.spread;
        const spreadY = (Math.random() - 0.5) * currentWeapon.spread;
        const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        direction.add(new THREE.Vector3(spreadX, spreadY, 0));
        direction.normalize();

        raycaster.set(camera.position, direction);

        // Detectar a qué golpea (Pared o Enemigo)
        const objectsToCheck = mapMesh ? [mapMesh, enemyMesh] : [enemyMesh];
        const intersects = raycaster.intersectObjects(objectsToCheck, true);

        if (intersects.length > 0) {
            // Si el objeto más cercano es el enemigo
            if (intersects[0].object === enemyMesh || intersects[0].object.parent === enemyMesh) {
                applyDamage(currentWeapon.dmg);
            }
            // Si golpea mapa, la bala se bloquea y no hace daño al enemigo detrás.
        }
    }
}

// ===============================
// MULTIJUGADOR ONLINE
// ===============================
function sendPlayerData() {
    if (isDead || !currentRoom) return;
    const myRef = ref(db, `rooms/${currentRoom}/players/${currentUser.uid}`);
    update(myRef, {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
        rotY: camera.rotation.y,
        hp: hp
    });
}

function syncEnemyData() {
    if (!currentRoom) return;
    const roomRef = ref(db, `rooms/${currentRoom}/players`);
    onValue(roomRef, (snapshot) => {
        const players = snapshot.val();
        if(!players) return;
        
        for (let uid in players) {
            if (uid !== currentUser.uid) {
                const enemyData = players[uid];
                document.getElementById('enemy-name-hud').innerText = enemyData.name;
                
                // Interpolar suavemente para evitar saltos (Lerp)
                enemyPosition.set(enemyData.x, enemyData.y - (CONFIG.PLAYER_HEIGHT/2), enemyData.z);
                enemyMesh.position.lerp(enemyPosition, 0.3);
                enemyMesh.rotation.y = enemyData.rotY || 0;

                enemyHP = enemyData.hp;
                document.getElementById('enemy-hp-bar').style.width = `${Math.max(0, enemyHP)}%`;
            }
        }
    }, { onlyOnce: false }); // Escucha constante gestionada por Firebase
}
syncEnemyData();

function applyDamage(amount) {
    if(enemyHP <= 0) return; // Ya muerto
    const enemyId = Object.keys(currentRoom?.players || {}).find(id => id !== currentUser.uid); // Fetch id
    // Atajo temporal para obtener EnemyId rápido consultando DB (en un entorno real se guarda localmente)
    getDatabase(app); 
    // Para simplificar, escribimos daño directamente (Arquitectura Cliente autoritativo)
    // *Nota Seguridad*: En GitHub Pages, la lógica ocurre en JS visible. Un usuario modificado podría enviar "enemigo HP = 0".
    const enemyRefPath = `rooms/${currentRoom}/players`;
    onValue(ref(db, enemyRefPath), (snap) => {
        const data = snap.val();
        for(let uid in data){
            if(uid !== currentUser.uid){
                let newHp = data[uid].hp - amount;
                update(ref(db, `${enemyRefPath}/${uid}`), { hp: newHp });
                if(newHp <= 0 && isHost) { // El host declara el final
                    update(ref(db, `rooms/${currentRoom}`), { status: 'finished', winner: currentUser.uid });
                }
            }
        }
    }, {onlyOnce: true});
}

function checkMyDeath() {
    // Si la DB dice que mi HP es 0 o menor
    const myRef = ref(db, `rooms/${currentRoom}/players/${currentUser.uid}/hp`);
    onValue(myRef, (snap) => {
        const myHP = snap.val();
        hp = myHP;
        updateHUD();
        if(hp <= 0 && !isDead) {
            isDead = true;
            // Si yo muero, el host (o el que me mató) declarará el winner. 
        }
    });
}
checkMyDeath();

function updateHUD() {
    document.getElementById('player-hp-bar').style.width = `${Math.max(0, hp)}%`;
    document.getElementById('player-hp-text').innerText = `${Math.max(0, hp)} HP`;
    document.getElementById('weapon-name').innerText = currentWeapon.name;
    document.getElementById('ammo-count').innerText = `${ammo} / ${currentWeapon.mag}`;
}

function endGameUI(isWinner) {
    document.exitPointerLock();
    showScreen(ui.end);
    document.getElementById('end-title').innerText = isWinner ? 'VICTORIA' : 'DERROTA';
    document.getElementById('end-subtitle').innerText = isWinner ? 'Has eliminado a tu rival.' : 'Has sido eliminado.';
}

document.getElementById('btn-play-again').onclick = () => {
    // Lógica para reiniciar (Requiere que ambos pulsen)
    document.getElementById('rematch-status').innerText = "Esperando al rival...";
    // Se resetearía el status de la sala en Firebase
};
document.getElementById('btn-leave-room').onclick = () => {
    remove(ref(db, `rooms/${currentRoom}`)); // Cierra sala
    currentRoom = null;
    showScreen(ui.lobby);
};

// ===============================
// BUCLE PRINCIPAL
// ===============================
let lastTime = performance.now();
function gameLoop() {
    if (ui.game.classList.contains('hidden')) return; // No renderizar si no estamos en juego
    
    const time = performance.now();
    const delta = Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;

    updatePhysics(delta);
    processShooting();
    
    renderer.render(scene, camera);
    gameLoopId = requestAnimationFrame(gameLoop);
}