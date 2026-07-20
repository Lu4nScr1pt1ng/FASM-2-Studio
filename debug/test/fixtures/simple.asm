format binary
use i386

start:
	mov eax, 1
	mov ebx, 2
	add eax, ebx
	int 0x80
