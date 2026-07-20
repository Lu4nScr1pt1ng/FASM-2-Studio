format binary

MAX_SIZE = 256

macro scale? factor*, value*
	imul value, factor
end macro
