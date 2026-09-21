// ===============================
// SISTEMA DE AUTENTICACIÓN Y PESTAÑAS
// ===============================
let authMode = 'login'; // 'login' o 'register'

const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const authTitle = document.getElementById('auth-title');
const btnAuthSubmit = document.getElementById('btn-auth-submit');
const authError = document.getElementById('auth-error');

// Cambio de pestaña a "Iniciar Sesión"
tabLogin.onclick = () => {
    authMode = 'login';
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    authTitle.innerText = 'BIENVENIDO DE NUEVO';
    btnAuthSubmit.innerText = 'ENTRAR AL LOBBY';
    authError.innerText = '';
};

// Cambio de pestaña a "Registrarse"
tabRegister.onclick = () => {
    authMode = 'register';
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    authTitle.innerText = 'CREAR NUEVA CUENTA';
    btnAuthSubmit.innerText = 'REGISTRARSE';
    authError.innerText = '';
};

// Convierte un nombre de usuario en un correo válido para Firebase
function formatEmail(username) {
    const cleanUser = username.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    return `${cleanUser}@fpsgame.com`;
}

// Acción del Botón Principal
btnAuthSubmit.onclick = () => {
    const rawUsername = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    authError.innerText = '';

    if (!rawUsername || !password) {
        authError.innerText = 'Ingresa usuario y contraseña.';
        return;
    }

    if (password.length < 6) {
        authError.innerText = 'La contraseña debe tener al menos 6 caracteres.';
        return;
    }

    // Adaptar entrada a correo para que Firebase no lo rechace
    const email = rawUsername.includes('@') ? rawUsername : formatEmail(rawUsername);

    if (authMode === 'login') {
        signInWithEmailAndPassword(auth, email, password)
            .then((userCredential) => {
                currentUser = userCredential.user;
                document.getElementById('username-display').innerText = rawUsername;
            })
            .catch((err) => {
                if (err.code === 'auth/invalid-credential' || err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password') {
                    authError.innerText = 'Usuario o contraseña incorrectos.';
                } else {
                    authError.innerText = 'Error al conectar. Revisa tus datos.';
                }
            });
    } else {
        createUserWithEmailAndPassword(auth, email, password)
            .then((userCredential) => {
                currentUser = userCredential.user;
                document.getElementById('username-display').innerText = rawUsername;
            })
            .catch((err) => {
                if (err.code === 'auth/email-already-in-use') {
                    authError.innerText = 'Ese usuario ya está registrado.';
                } else {
                    authError.innerText = 'Error al registrar la cuenta.';
                }
            });
    }
};

// Escuchador de estado de sesión
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        const savedName = document.getElementById('username').value.trim() || user.email.split('@')[0];
        document.getElementById('username-display').innerText = savedName;
        showScreen(ui.lobby);
    } else {
        currentUser = null;
        showScreen(ui.auth);
    }
});
