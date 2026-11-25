#!/usr/bin/env node
'use strict';

/**
 * Genereer een willekeurige 32-byte encryptie key voor TOKEN_ENCRYPTION_KEY.
 * Kopieer de output naar je .env bestand.
 */

const crypto = require('crypto');
console.log(crypto.randomBytes(32).toString('base64'));
