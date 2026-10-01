# ONAIG

All software components used are open-source and free for commercial use.  

## Naming
- face: user's face RGB image
- facevector: array of 512 numbers embedding the face
- enrollment: process of registering a user's facevector
- authentication: process of verifying a user's facevector against a previously enrolled facevector
 
## Protocol

The ONAIG protocol consists of two main flows:
1. **Enrollment**: The user enrolls his face.
2. **Authentication**: The user authenticates using his face.

We have two actors:
- client
- server