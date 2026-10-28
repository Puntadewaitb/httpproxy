import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { generateCACertificate } from 'mockttp';

export interface CertAuthority {
  key: string;
  cert: string;
  keyPath: string;
  certPath: string;
  /** SHA-256 fingerprint, buat verifikasi CA yang terpasang di device. */
  fingerprint: string;
  /** true kalau CA baru dibuat pada pemanggilan ini. */
  created: boolean;
}

/**
 * Load CA dari `dir`, atau generate baru kalau belum ada.
 * Setiap instalasi punya CA unik, private key disimpan dengan permission 0600.
 */
export async function loadOrCreateCA(dir: string, commonName = 'ProxyKit Root CA'): Promise<CertAuthority> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, 'ca-key.pem');
  const certPath = join(dir, 'ca-cert.pem');

  let created = false;
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const ca = await generateCACertificate({
      subject: { commonName, organizationName: 'ProxyKit (local)' },
      bits: 2048,
    });
    // Tulis key dulu dengan mode ketat, baru cert.
    await writeFile(keyPath, ca.key, { mode: 0o600 });
    await writeFile(certPath, ca.cert, { mode: 0o644 });
    created = true;
  }
  // Pastikan permission tetap ketat walau file sudah ada / umask longgar.
  await chmod(keyPath, 0o600).catch(() => {});

  const [key, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')]);
  const fingerprint = new X509Certificate(cert).fingerprint256;
  return { key, cert, keyPath, certPath, fingerprint, created };
}
