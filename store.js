/* All Firebase access lives here, so app.js only deals in plain objects.

   Firestore layout:
     config/invite                                   { code }  -- set in the console only
     users/{uid}                                     profile: name, inviteCode, emailReminders
     users/{uid}/certs/{certId}                      one certification (card.front / card.back = current card)
     users/{uid}/certs/{certId}/cycles/{cycleId}     one renewal period (current or archived)
       .../cycles/{cycleId}/files/{fileId}           uploaded proof (points at a Storage path)
       .../cycles/{cycleId}/entries/{entryId}        optional classes-taught / hours log

   Storage mirrors it under users/{uid}/..., so the rules can check ownership
   just from the path. */
const Store = (() => {
  const configured = typeof firebaseConfig !== 'undefined' && !/PASTE/.test(firebaseConfig.apiKey);
  if (!configured) return { configured: false };

  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const storage = firebase.storage();

  db.enablePersistence({ synchronizeTabs: true }).catch(err => {
    // Private browsing and some multi-tab setups can't cache offline. The app
    // still works online without it.
    console.warn('Firestore offline persistence unavailable:', err.code);
  });

  const ts = () => firebase.firestore.FieldValue.serverTimestamp();
  const uid = () => auth.currentUser.uid;
  const userDoc = () => db.collection('users').doc(uid());
  const certsCol = () => userDoc().collection('certs');
  const cyclesCol = certId => certsCol().doc(certId).collection('cycles');
  const certDir = certId => `users/${uid()}/certs/${certId}`;
  const withId = d => ({ id: d.id, ...d.data() });

  // Matches storage.rules -- checked here first so people get a clear message
  // instead of a generic permission error.
  const MAX_FILE_MB = 10;
  function checkFiles(files) {
    for (const f of files) {
      if (!/^image\/|^application\/pdf$/.test(f.type)) throw new Error(`"${f.name}" isn't a PDF or photo.`);
      if (f.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`"${f.name}" is over ${MAX_FILE_MB} MB.`);
    }
  }

  async function putFile(dir, file) {
    const path = `${dir}/${Date.now()}-${file.name.replace(/[^\w.\-]+/g, '_')}`;
    await storage.ref(path).put(file, { contentType: file.type });
    return { path, name: file.name, size: file.size, contentType: file.type };
  }

  const ignoreMissing = e => { if (e.code !== 'storage/object-not-found') throw e; };
  const removeFile = path => storage.ref(path).delete().catch(ignoreMissing);

  async function deleteStorageTree(path) {
    const res = await storage.ref(path).listAll();
    await Promise.all(res.items.map(i => i.delete().catch(ignoreMissing)));
    for (const p of res.prefixes) await deleteStorageTree(p.fullPath);
  }

  async function deleteDocs(snap) {
    // Batches cap at 500 writes; chunk to be safe for big histories.
    for (let i = 0; i < snap.docs.length; i += 400) {
      const b = db.batch();
      snap.docs.slice(i, i + 400).forEach(d => b.delete(d.ref));
      await b.commit();
    }
  }

  async function deleteCertDocs(certId) {
    const cycles = await cyclesCol(certId).get();
    for (const c of cycles.docs) {
      await deleteDocs(await c.ref.collection('files').get());
      await deleteDocs(await c.ref.collection('entries').get());
    }
    await deleteDocs(cycles);
    await certsCol().doc(certId).delete();
  }

  async function getCycles(certId) {
    const snap = await cyclesCol(certId).get();
    const cycles = await Promise.all(snap.docs.map(async d => {
      const [files, entries] = await Promise.all([d.ref.collection('files').get(), d.ref.collection('entries').get()]);
      return {
        ...withId(d),
        files: files.docs.map(withId).sort((a, b) => (b.uploadedMs || 0) - (a.uploadedMs || 0)),
        entries: entries.docs.map(withId).sort((a, b) => (b.date || '').localeCompare(a.date || '')),
      };
    }));
    return cycles.sort((a, b) => (b.expiresOn || '').localeCompare(a.expiresOn || ''));
  }

  return {
    configured: true,
    MAX_FILE_MB,
    checkFiles,

    // ---- auth ----
    onAuth: cb => auth.onAuthStateChanged(cb),
    currentUser: () => auth.currentUser,
    signIn: (email, pw) => auth.signInWithEmailAndPassword(email, pw),
    signUp: (email, pw) => auth.createUserWithEmailAndPassword(email, pw),
    signOut: () => auth.signOut(),
    resetPassword: email => auth.sendPasswordResetEmail(email),
    reauth(password) {
      const u = auth.currentUser;
      return u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, password));
    },

    // ---- profile ----
    async getProfile() {
      const s = await userDoc().get();
      return s.exists ? s.data() : null;
    },
    // The rules only allow this when inviteCode matches config/invite.
    createProfile: ({ name, inviteCode }) =>
      userDoc().set({ name, inviteCode, emailReminders: true, createdAt: ts() }),
    updateProfile: data => userDoc().update(data),

    // ---- certs ----
    watchCerts: (cb, onErr) => certsCol().onSnapshot(s => cb(s.docs.map(withId)), onErr),

    async createCert(data) {
      const ref = certsCol().doc();
      const cycle = cyclesCol(ref.id).doc();
      const b = db.batch();
      b.set(cycle, { startOn: data.issuedOn || null, expiresOn: data.expiresOn, status: 'current', createdAt: ts() });
      b.set(ref, { ...data, currentCycleId: cycle.id, remindersSent: [], snoozedUntil: null, createdAt: ts(), updatedAt: ts() });
      await b.commit();
      return ref.id;
    },

    async updateCert(cert, data) {
      const b = db.batch();
      const patch = { ...data, updatedAt: ts() };
      const datesChanged = data.expiresOn !== cert.expiresOn || (data.issuedOn || null) !== (cert.issuedOn || null);
      // A corrected expiration means the reminder schedule starts over.
      if (data.expiresOn !== cert.expiresOn) patch.remindersSent = [];
      b.update(certsCol().doc(cert.id), patch);
      if (datesChanged) {
        b.update(cyclesCol(cert.id).doc(cert.currentCycleId), { startOn: data.issuedOn || null, expiresOn: data.expiresOn });
      }
      await b.commit();
    },

    snooze: (certId, until) => certsCol().doc(certId).update({ snoozedUntil: until }),

    async deleteCert(cert) {
      await deleteStorageTree(certDir(cert.id));
      await deleteCertDocs(cert.id);
    },

    // Archives the current cycle (its files stay put) and opens a fresh one.
    // The old card is filed into the archived cycle's documents, not deleted.
    async renewCert(cert, { renewedOn, expiresOn }) {
      const next = cyclesCol(cert.id).doc();
      const oldCycle = cyclesCol(cert.id).doc(cert.currentCycleId);
      const b = db.batch();
      for (const side of ['front', 'back']) {
        const f = cert.card && cert.card[side];
        if (f) b.set(oldCycle.collection('files').doc(), { ...f, name: `Card (${side}) - ${f.name}`, uploadedMs: Date.now() });
      }
      b.update(oldCycle, { status: 'archived', renewedOn, archivedAt: ts() });
      b.set(next, { startOn: renewedOn, expiresOn, status: 'current', createdAt: ts() });
      b.update(certsCol().doc(cert.id), {
        issuedOn: renewedOn, expiresOn, lastRenewedOn: renewedOn, currentCycleId: next.id,
        card: null, remindersSent: [], snoozedUntil: null, updatedAt: ts(),
      });
      await b.commit();
      return next.id;
    },

    // ---- documents ----
    getCycles,

    async uploadFiles(certId, cycleId, files) {
      checkFiles(files);
      for (const file of files) {
        const meta = await putFile(`${certDir(certId)}/cycles/${cycleId}`, file);
        await cyclesCol(certId).doc(cycleId).collection('files').add({ ...meta, uploadedMs: Date.now() });
      }
    },

    async deleteFile(certId, cycleId, file) {
      await removeFile(file.path);
      await cyclesCol(certId).doc(cycleId).collection('files').doc(file.id).delete();
    },

    fileUrl: path => storage.ref(path).getDownloadURL(),

    async setInstructionsFile(cert, file) {
      checkFiles([file]);
      const meta = await putFile(`${certDir(cert.id)}/instructions`, file);
      if (cert.instructionsFile) await removeFile(cert.instructionsFile.path);
      await certsCol().doc(cert.id).update({ instructionsFile: meta });
      return meta;
    },

    async removeInstructionsFile(cert) {
      if (cert.instructionsFile) await removeFile(cert.instructionsFile.path);
      await certsCol().doc(cert.id).update({ instructionsFile: null });
    },

    // ---- the current card (front and optional back) ----
    async setCardFile(cert, side, file) {
      checkFiles([file]);
      const meta = await putFile(`${certDir(cert.id)}/card`, file);
      const old = cert.card && cert.card[side];
      await certsCol().doc(cert.id).update({ [`card.${side}`]: meta });
      if (old) await removeFile(old.path);
      return meta;
    },

    async removeCardFile(cert, side) {
      const old = cert.card && cert.card[side];
      await certsCol().doc(cert.id).update({ [`card.${side}`]: firebase.firestore.FieldValue.delete() });
      if (old) await removeFile(old.path);
    },

    // ---- optional tracker log ----
    async addEntry(certId, cycleId, entry, file) {
      const data = { ...entry, createdMs: Date.now() };
      if (file) {
        checkFiles([file]);
        data.file = await putFile(`${certDir(certId)}/cycles/${cycleId}/entries`, file);
      }
      await cyclesCol(certId).doc(cycleId).collection('entries').add(data);
    },

    async deleteEntry(certId, cycleId, entry) {
      if (entry.file) await removeFile(entry.file.path);
      await cyclesCol(certId).doc(cycleId).collection('entries').doc(entry.id).delete();
    },

    // ---- export + account deletion ----
    // Every stored file with the folder it belongs in inside the ZIP.
    async listAllFiles(certs, labelOf) {
      const safe = s => String(s || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').trim();
      const out = [];
      for (const cert of certs) {
        const root = safe(labelOf(cert));
        if (cert.instructionsFile) out.push({ path: cert.instructionsFile.path, zipPath: `${root}/Instructions/${safe(cert.instructionsFile.name)}` });
        for (const side of ['front', 'back']) {
          const f = cert.card && cert.card[side];
          if (f) out.push({ path: f.path, zipPath: `${root}/Current card/${side} - ${safe(f.name)}` });
        }
        for (const cy of await getCycles(cert.id)) {
          const dir = `${root}/${cy.startOn || 'start'} to ${cy.expiresOn || 'end'}${cy.id === cert.currentCycleId ? ' (current)' : ''}`;
          cy.files.forEach(f => out.push({ path: f.path, zipPath: `${dir}/${safe(f.name)}` }));
          cy.entries.filter(e => e.file).forEach(e => out.push({ path: e.file.path, zipPath: `${dir}/${safe(cert.trackerLabel || 'Log')}/${e.date} ${safe(e.file.name)}` }));
        }
      }
      return out;
    },

    async deleteAccount() {
      await deleteStorageTree(`users/${uid()}`);
      for (const d of (await certsCol().get()).docs) await deleteCertDocs(d.id);
      // The profile goes last: the rules only allow touching the certs while it exists.
      await userDoc().delete();
      await auth.currentUser.delete();
    },
  };
})();
