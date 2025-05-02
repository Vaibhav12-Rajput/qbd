exports.ensureArray = (input) => {
    if(!input){
        return [];
    }
    if(Array.isArray(input))
        return input;
    else 
        return [input];
}